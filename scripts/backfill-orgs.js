/**
 * ADA Sports — One-time backfill: create orgs/{orgId} docs for existing coaches.
 *
 * Slots existing coaches into founder/free tiers by their REAL signup order
 * (users.createdAt ascending), so the "first 50 coaches" promise is honored
 * for people who already signed up before this system existed — not reset
 * to zero. Also seeds meta/counters.coachSignupCount so new signups after
 * this script continue the count correctly (via onUserCreated).
 *
 * Run ONCE, locally, with the Firebase Admin SDK service account:
 *   node scripts/backfill-orgs.js
 *
 * Requires: npm install firebase-admin
 * Requires: a service account key JSON — set GOOGLE_APPLICATION_CREDENTIALS
 *   env var to its path before running, e.g.:
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node scripts/backfill-orgs.js
 *
 * Safe to re-run: skips any org doc that already exists.
 */

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const FOUNDER_COACH_LIMIT   = 50;
const FOUNDER_ATHLETE_LIMIT = 20;
const FREE_ATHLETE_LIMIT    = 5;
const COACH_LIMIT           = 1;

async function main() {
  console.log('Fetching all coach accounts, ordered by signup time...');

  const coachSnap = await db.collection('users')
    .where('role', '==', 'coach')
    .orderBy('createdAt', 'asc')
    .get();

  console.log(`Found ${coachSnap.size} coach accounts.`);

  let created = 0;
  let skipped = 0;
  let index = 0; // 0-indexed signup order

  for (const doc of coachSnap.docs) {
    const data = doc.data();
    const orgId = data.orgId || doc.id;
    const orgRef = db.collection('orgs').doc(orgId);

    const existing = await orgRef.get();
    if (existing.exists) {
      console.log(`  [skip] orgs/${orgId} already exists`);
      skipped++;
      index++;
      continue;
    }

    const isFounder = index < FOUNDER_COACH_LIMIT;

    // Count this coach's already-existing athletes so athleteCount starts accurate,
    // not zero.
    const athleteSnap = await db.collection('users')
      .where('role', '==', 'athlete')
      .where('orgId', '==', orgId)
      .get();

    await orgRef.set({
      tier:          isFounder ? 'founder' : 'free',
      earlyAdopter:  isFounder,
      athleteLimit:  isFounder ? FOUNDER_ATHLETE_LIMIT : FREE_ATHLETE_LIMIT,
      coachLimit:    COACH_LIMIT,
      athleteCount:  athleteSnap.size,
      signupOrder:   index + 1,
      createdAt:     data.createdAt || FieldValue.serverTimestamp(),
      backfilled:    true,
    });

    console.log(`  [created] orgs/${orgId} — tier=${isFounder ? 'founder' : 'free'}, athletes=${athleteSnap.size}`);
    created++;
    index++;
  }

  // Seed the counter so future signups (handled by onUserCreated) continue
  // from the right number instead of restarting at 0.
  await db.collection('meta').doc('counters').set(
    { coachSignupCount: coachSnap.size },
    { merge: true }
  );

  console.log('\nDone.');
  console.log(`  Created: ${created}`);
  console.log(`  Skipped (already existed): ${skipped}`);
  console.log(`  meta/counters.coachSignupCount set to ${coachSnap.size}`);
}

main().catch((e) => {
  console.error('Backfill failed:', e);
  process.exit(1);
});
