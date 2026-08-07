/**
 * ADA Sports — Entitlement Cloud Functions
 * Firebase Functions v2 (Node.js), Firestore triggers.
 *
 * Responsibilities:
 *  1. When a coach's users/{uid} doc is created, create the matching orgs/{orgId}
 *     doc with a tier decided by signup order (first FOUNDER_COACH_LIMIT coaches
 *     ever get 'founder', everyone after gets 'free'). Decision + counter increment
 *     happen inside a single Firestore transaction, so this is race-safe even under
 *     concurrent signups.
 *  2. Keep orgs/{orgId}.athleteCount in sync whenever an athlete users/{uid} doc
 *     is created or deleted.
 *
 * Enforcement of the actual cap happens in firestore.rules, not here — this file
 * only maintains the counters and tier assignment that the rules read.
 *
 * Deploy: firebase deploy --only functions
 */

const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

initializeApp();
const db = getFirestore();
const auth = getAuth();

const FOUNDER_COACH_LIMIT   = 50;  // first N coaches (by signup order) get founder tier
const FOUNDER_ATHLETE_LIMIT = 20;
const FREE_ATHLETE_LIMIT    = 5;
const COACH_LIMIT           = 1;   // current schema: 1 coach == 1 org, always

const COUNTERS_DOC = db.collection('meta').doc('counters');

/**
 * Fires on ANY users/{uid} creation. Branches on role.
 * Combined into one function (rather than two separate triggers on the same
 * path) to keep the role-branching logic in one place.
 *
 * role === 'assistantCoach' is deliberately not handled here — an assistant
 * coach is attached to their head coach's existing orgId (see
 * generateAssistantInviteCode / lookupAssistantCoachByInviteCode below) and
 * must never get an orgs/{orgId} doc, tier, or athleteLimit of their own.
 *
 * Only fires on document CREATION — an athlete linking to a coach after
 * their initial signup is an UPDATE to an existing doc, not a create, and
 * is handled separately by onUserUpdated below.
 */
exports.onUserCreated = onDocumentCreated('users/{uid}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data();
  if (!data || !data.role) return;

  if (data.role === 'coach') {
    await handleCoachCreated(data);
  } else if (data.role === 'athlete') {
    await handleAthleteCreated(data);
  }
});

async function handleCoachCreated(data) {
  const orgId = data.orgId; // by current schema, orgId === coach uid
  if (!orgId) return;

  const orgRef = db.collection('orgs').doc(orgId);

  await db.runTransaction(async (tx) => {
    const orgSnap = await tx.get(orgRef);
    if (orgSnap.exists) return; // idempotency guard — safe on function retries

    const counterSnap = await tx.get(COUNTERS_DOC);
    const coachSignupCount = (counterSnap.exists && counterSnap.data().coachSignupCount) || 0;

    const isFounder = coachSignupCount < FOUNDER_COACH_LIMIT;

    tx.set(orgRef, {
      tier:          isFounder ? 'founder' : 'free',
      earlyAdopter:  isFounder,
      athleteLimit:  isFounder ? FOUNDER_ATHLETE_LIMIT : FREE_ATHLETE_LIMIT,
      coachLimit:    COACH_LIMIT,
      athleteCount:  0,
      signupOrder:   coachSignupCount + 1, // 1-indexed, useful for support/debugging
      createdAt:     FieldValue.serverTimestamp(),
    });

    tx.set(COUNTERS_DOC, { coachSignupCount: coachSignupCount + 1 }, { merge: true });
  });
}

async function handleAthleteCreated(data) {
  const orgId = data.orgId;
  if (!orgId) return;

  // If this fails (org doc not yet created — see race note below), it's a no-op.
  // athleteCount will be off by one in that rare edge case; acceptable trade-off
  // given the security rule fails closed (blocks signup) rather than open.
  await db.collection('orgs').doc(orgId)
    .update({ athleteCount: FieldValue.increment(1) })
    .catch((e) => {
      console.error(`Failed to increment athleteCount for org ${orgId}:`, e.message);
    });
}

/**
 * Keeps orgs/{orgId}.athleteCount accurate when an EXISTING athlete's orgId
 * changes — linking to a coach for the first time after a self-org signup,
 * switching from one coach to another, or unlinking back to self-org.
 *
 * This is the piece handleAthleteCreated (above) can't cover: that only
 * fires on onDocumentCreated, i.e. brand-new docs at signup time. An athlete
 * who signs up self-org and links to a coach LATER is doing an update to an
 * already-existing doc, which never fires the create trigger — so without
 * this, a coach's athleteCount silently never increments for any athlete
 * who links post-signup rather than joining directly via invite code at
 * signup time (see athleteSignupAllowed's orgId == athleteUid branch).
 *
 * Symmetric: decrements the OLD org (if any) and increments the NEW org (if
 * any), same tolerant fire-and-log-don't-throw pattern as the rest of this
 * file — a self-org orgId has no orgs/{orgId} doc to update in the first
 * place, so that side is just a harmless no-op via the .catch().
 */
exports.onUserUpdated = onDocumentUpdated('users/{uid}', async (event) => {
  const before = event.data && event.data.before && event.data.before.data();
  const after  = event.data && event.data.after  && event.data.after.data();
  if (!before || !after) return;
  if (after.role !== 'athlete') return;

  const oldOrgId = before.orgId;
  const newOrgId = after.orgId;
  if (oldOrgId === newOrgId) return; // no org change — nothing to reconcile

  const ops = [];
  if (oldOrgId) {
    ops.push(
      db.collection('orgs').doc(oldOrgId)
        .update({ athleteCount: FieldValue.increment(-1) })
        .catch((e) => {
          console.error(`Failed to decrement athleteCount for org ${oldOrgId}:`, e.message);
        })
    );
  }
  if (newOrgId) {
    ops.push(
      db.collection('orgs').doc(newOrgId)
        .update({ athleteCount: FieldValue.increment(1) })
        .catch((e) => {
          console.error(`Failed to increment athleteCount for org ${newOrgId}:`, e.message);
        })
    );
  }
  await Promise.all(ops);
});

/**
 * Keep athleteCount accurate when an athlete account is deleted
 * (e.g. via the existing in-app "Delete Account" flow), and clean up the
 * orgs/{orgId} doc entirely when a COACH account is deleted.
 *
 * The client-side delete flow (confirmDeleteAccount() in coach-desktop.html)
 * cannot touch orgs/* itself — writes there are Admin-SDK-only by rule — so
 * this is the only place that org doc ever gets removed.
 *
 * Deliberately NOT decremented here: meta/counters.coachSignupCount. That
 * counter tracks how many coaches have EVER signed up, to keep the founder
 * cutoff (first 50) fair — if it went down on deletion, a later signup could
 * wrongly reclaim a founder slot that was already spent.
 *
 * role === 'assistantCoach' also deliberately falls through both branches
 * below untouched — deleting an assistant coach must not decrement the head
 * coach's athleteCount or delete the shared orgs/{orgId} doc, since the
 * assistant never owned either. See deleteAssistantCoachAccount below for
 * their actual delete path.
 */
exports.onUserDeleted = onDocumentDeleted('users/{uid}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data();
  if (!data || !data.orgId) return;

  if (data.role === 'athlete') {
    await db.collection('orgs').doc(data.orgId)
      .update({ athleteCount: FieldValue.increment(-1) })
      .catch((e) => {
        console.error(`Failed to decrement athleteCount for org ${data.orgId}:`, e.message);
      });
    return;
  }

  if (data.role === 'coach') {
    await db.collection('orgs').doc(data.orgId).delete()
      .catch((e) => {
        console.error(`Failed to delete orgs/${data.orgId} after coach deletion:`, e.message);
      });
  }
});

/**
 * Checks a batch of candidate invite codes for availability, used by
 * uniqueInviteCode() during coach signup. Runs with Admin SDK privileges so
 * the client never needs direct list access to the `users` collection for
 * this — that broad access is exactly what the removed
 * `allow list: if isSignedIn() && request.query.limit <= 1` rule allowed,
 * and it had no way to scope it to "just checking one field's uniqueness"
 * versus "read any arbitrary user document."
 */
exports.checkInviteCodesAvailable = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    const raw = (request.data && request.data.codes) || [];
    if (!Array.isArray(raw) || !raw.length) {
      throw new HttpsError('invalid-argument', 'codes must be a non-empty array.');
    }
    const codes = raw
      .map((c) => String(c).trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 10); // Firestore 'in' query limit

    if (!codes.length) {
      throw new HttpsError('invalid-argument', 'codes must contain at least one non-empty value.');
    }

    const snap = await db.collection('users')
      .where('inviteCode', 'in', codes)
      .get();

    const taken = snap.docs.map((d) => d.data().inviteCode);
    return { taken };
  }
);

/**
 * Public invite-code lookup, callable BEFORE the visitor has an account.
 *
 * Runs with Admin SDK privileges (bypasses Firestore rules entirely), which is
 * the whole point: the client-side pre-signup check has no auth session yet,
 * so a direct Firestore query from the browser is correctly blocked by rules
 * (`allow list: if isSignedIn()...`). Routing the lookup through this function
 * instead means it works identically whether the visitor is signed in or not,
 * and it only ever returns the minimal, non-sensitive fields needed to show
 * "linked to coach: X" — never the coach's full user document (email, uid
 * roster, etc.), which a public Firestore rule would have had to expose.
 */
exports.lookupCoachByInviteCode = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    const raw = (request.data && request.data.code) || '';
    const code = String(raw).trim().toUpperCase();
    if (!code) {
      throw new HttpsError('invalid-argument', 'Invite code is required.');
    }

    const snap = await db.collection('users')
      .where('role', '==', 'coach')
      .where('inviteCode', '==', code)
      .limit(1)
      .get();

    if (snap.empty) {
      return { found: false };
    }

    const doc = snap.docs[0];
    const d = doc.data();
    return {
      found: true,
      uid: doc.id,
      orgId: d.orgId || doc.id,
      name: d.name || '',
      discipline: d.discipline || '',
    };
  }
);

/**
 * Deletes a coach's account and all associated data server-side, replacing
 * the previous client-side sequence in confirmDeleteAccount()
 * (coach-desktop.html), which had no rule permission to write to athlete
 * docs and left accounts half-deleted on any mid-sequence failure.
 *
 * Runs with Admin SDK privileges so it can, in one pass:
 *   - unlink every assigned athlete by resetting them to a proper self-org
 *     (orgId: their own uid, per schema) rather than orgId: '' — the old
 *     client code left unlinked athletes with an invalid empty orgId.
 *   - delete the coach's season + microcycle docs.
 *   - delete the coach's users/{uid} doc — this fires onUserDeleted above,
 *     which removes orgs/{orgId}, so that cleanup is not duplicated here.
 *   - delete the Firebase Auth user.
 *
 * The client still handles password re-authentication before calling this —
 * re-checking a password requires the client Auth SDK and is the accepted
 * UX confirmation step for a destructive action; it's not a security
 * dependency of this function, which independently trusts only
 * request.auth.uid.
 */
exports.deleteCoachAccount = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }
    const uid = request.auth.uid;

    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError('not-found', 'Account not found.');
    }
    const data = userSnap.data();
    if (data.role !== 'coach') {
      throw new HttpsError('permission-denied', 'Only coach accounts can be deleted with this function.');
    }

    const orgId = data.orgId || uid;
    const assignedAthletes = Array.isArray(data.assignedAthletes) ? data.assignedAthletes : [];

    // Collect every write, then commit in chunks of <=500 (Firestore batch
    // limit), so a large roster or multi-year season history can't overflow
    // a single batch.
    const ops = [];

    assignedAthletes.forEach((athUid) => {
      // set+merge rather than update: tolerates a stale assignedAthletes
      // entry pointing at an athlete doc that no longer exists, instead of
      // aborting the whole batch on a NOT_FOUND.
      ops.push({
        ref: db.collection('users').doc(athUid),
        data: { orgId: athUid, coachId: FieldValue.delete() },
        merge: true,
      });
    });

    const microSnap = await db.collection('seasons').doc(orgId).collection('microcycles').get();
    microSnap.docs.forEach((d) => ops.push({ ref: d.ref, delete: true }));

    ops.push({ ref: db.collection('seasons').doc(orgId), delete: true });
    ops.push({ ref: userRef, delete: true });

    for (let i = 0; i < ops.length; i += 500) {
      const batch = db.batch();
      ops.slice(i, i + 500).forEach((op) => {
        if (op.delete) batch.delete(op.ref);
        else batch.set(op.ref, op.data, { merge: true });
      });
      await batch.commit();
    }

    // Auth deletion happens last and can't be rolled back — all Firestore
    // state above is already fully committed by this point.
    await auth.deleteUser(uid).catch((e) => {
      console.error(`Failed to delete Auth user ${uid} after Firestore cleanup:`, e.message);
      throw new HttpsError('internal', 'Account data was removed, but the login credential could not be deleted. Contact support.');
    });

    return { success: true };
  }
);

const ASSISTANT_CODE_LENGTH = 6;
// Excludes O/0 and I/1 — visually ambiguous when a coach reads the code aloud
// or an assistant retypes it from a photo of a whiteboard.
const ASSISTANT_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomAssistantCode(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ASSISTANT_CODE_CHARS[Math.floor(Math.random() * ASSISTANT_CODE_CHARS.length)];
  }
  return out;
}

/**
 * Generates (or returns the existing) invite code a head coach can share
 * with an assistant coach. Stored on the head coach's own users/{uid} doc
 * as `assistantInviteCode` — a field deliberately separate from the
 * athlete-facing `inviteCode`, so the two code spaces can never collide
 * with each other's signup flow even if a code string happened to match.
 *
 * Idempotent by default: calling this again just returns the code already
 * on file, so re-opening the "Invite Assistant Coach" UI doesn't silently
 * invalidate a code the coach already texted someone. Pass
 * { regenerate: true } to force a fresh one (e.g. the old code leaked).
 *
 * Only a signed-in coach (role === 'coach') may call this — assistant
 * coaches cannot invite further assistants, and athletes cannot invite
 * anyone.
 */
exports.generateAssistantInviteCode = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const uid = request.auth.uid;
    const callerRef = db.collection('users').doc(uid);
    const callerSnap = await callerRef.get();
    if (!callerSnap.exists || callerSnap.data().role !== 'coach') {
      throw new HttpsError('permission-denied', 'Only head coaches can invite assistant coaches.');
    }

    const existing = callerSnap.data().assistantInviteCode;
    const forceNew = !!(request.data && request.data.regenerate);
    if (existing && !forceNew) {
      return { code: existing };
    }

    // Retry on collision against both code fields — the ~1.3 billion possible
    // codes make collisions rare, but check anyway rather than trust probability.
    let code;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = randomAssistantCode(ASSISTANT_CODE_LENGTH);
      const [byInvite, byAssistant] = await Promise.all([
        db.collection('users').where('inviteCode', '==', candidate).limit(1).get(),
        db.collection('users').where('assistantInviteCode', '==', candidate).limit(1).get(),
      ]);
      if (byInvite.empty && byAssistant.empty) { code = candidate; break; }
    }
    if (!code) {
      throw new HttpsError('internal', 'Could not generate a unique code — please try again.');
    }

    await callerRef.set(
      { assistantInviteCode: code, assistantInviteCodeCreatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    return { code };
  }
);

/**
 * Public lookup for an assistant-coach invite code, callable BEFORE the
 * visitor has an account — mirrors lookupCoachByInviteCode's shape and
 * privacy rationale (Admin SDK bypass, minimal fields returned), but reads
 * the assistantInviteCode field instead. signup.html's assistant-coach path
 * calls this to resolve which head coach (and orgId) the new assistant
 * account should attach to.
 */
exports.lookupAssistantCoachByInviteCode = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    const raw = (request.data && request.data.code) || '';
    const code = String(raw).trim().toUpperCase();
    if (!code) {
      throw new HttpsError('invalid-argument', 'Invite code is required.');
    }

    const snap = await db.collection('users')
      .where('role', '==', 'coach')
      .where('assistantInviteCode', '==', code)
      .limit(1)
      .get();

    if (snap.empty) {
      return { found: false };
    }

    const doc = snap.docs[0];
    const d = doc.data();
    return {
      found: true,
      uid: doc.id,
      orgId: d.orgId || doc.id,
      name: d.name || '',
      discipline: d.discipline || '',
    };
  }
);

/**
 * Assistant coaches deleting their own account only ever need to remove
 * their own users/{uid} doc and Auth user — they never owned the head
 * coach's athletes, season, or microcycles, only had scoped rule-based
 * access to them, so there is nothing else to clean up or re-org.
 *
 * Intentionally not shared code with deleteCoachAccount above: that
 * function's athlete re-org and season/microcycle deletion steps would be
 * actively wrong to run for an assistant, since an assistant never owns
 * that data.
 */
exports.deleteAssistantCoachAccount = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const uid = request.auth.uid;
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists || snap.data().role !== 'assistantCoach') {
      throw new HttpsError('permission-denied', 'This function is only for assistant coach accounts.');
    }

    await db.collection('users').doc(uid).delete();

    await auth.deleteUser(uid).catch((e) => {
      console.error(`Failed to delete Auth user ${uid}:`, e.message);
      throw new HttpsError('internal', 'Account data was removed, but the login credential could not be deleted. Contact support.');
    });

    return { success: true };
  }
);

/**
 * Lets a head coach remove one of THEIR OWN assistant coaches. There is no
 * softer "unlink but keep the account" option here, unlike athletes — an
 * assistant coach account has no data of its own (no athletes, no season)
 * to fall back to as a self-org, so a detached assistant account would just
 * be a dead end. Removal is equivalent to that assistant calling
 * deleteAssistantCoachAccount on themselves, just initiated by their head
 * coach instead — full account + Auth deletion, plus (unlike the assistant's
 * own self-delete path) cleaning up the stale entry this would otherwise
 * leave behind in the head coach's own `assistants` array.
 */
exports.removeAssistantCoach = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const callerUid = request.auth.uid;
    const callerSnap = await db.collection('users').doc(callerUid).get();
    if (!callerSnap.exists || callerSnap.data().role !== 'coach') {
      throw new HttpsError('permission-denied', 'Only head coaches can remove an assistant coach.');
    }

    const assistantUid = (request.data && request.data.assistantUid) || '';
    if (!assistantUid) {
      throw new HttpsError('invalid-argument', 'assistantUid is required.');
    }

    const assistantRef = db.collection('users').doc(assistantUid);
    const assistantSnap = await assistantRef.get();
    if (!assistantSnap.exists || assistantSnap.data().role !== 'assistantCoach') {
      throw new HttpsError('not-found', 'Assistant coach account not found.');
    }
    // Must be MY assistant — a coach cannot remove another coach's staff.
    if (assistantSnap.data().coachId !== callerUid) {
      throw new HttpsError('permission-denied', 'This assistant coach is not linked to your account.');
    }

    await assistantRef.delete();

    await db.collection('users').doc(callerUid).update({
      assistants: FieldValue.arrayRemove(assistantUid)
    }).catch((e) => {
      // Non-fatal — the assistant's account and access are already fully
      // gone by this point; a stale uid left in the array is a cosmetic
      // display issue only, same class as the athleteCount race noted above.
      console.error(`Failed to clean up assistants array for coach ${callerUid}:`, e.message);
    });

    await auth.deleteUser(assistantUid).catch((e) => {
      console.error(`Failed to delete Auth user ${assistantUid}:`, e.message);
      throw new HttpsError('internal', 'Assistant data was removed, but the login credential could not be deleted. Contact support.');
    });

    return { success: true };
  }
);
