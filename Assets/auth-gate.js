/**
 * ADA Sports — Unified Auth Gate v3
 * Handles all roles: superadmin | admin | coach | athlete
 * Single users/{uid} read with retry. Sets window.ADA_USER, fires ada:ready.
 * Replaces both auth-gate.js and coach-auth-gate.js.
 */
(function () {
  const auth = firebase.auth();
  const db   = firebase.firestore();

  // Loading overlay
  const overlay = document.createElement('div');
  overlay.id = 'ada-auth-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:#0A1409;display:flex;align-items:center;justify-content:center;z-index:9999;flex-direction:column;gap:12px';
  overlay.innerHTML = `
    <div style="width:36px;height:36px;border:3px solid rgba(255,255,255,0.1);border-top-color:#4ade80;border-radius:50%;animation:_ag_spin 0.8s linear infinite"></div>
    <div style="font-family:'IBM Plex Mono',monospace;font-size:0.72rem;color:#5A7A58">Loading...</div>
    <style>@keyframes _ag_spin{to{transform:rotate(360deg)}}</style>`;
  document.body.appendChild(overlay);

  async function getWithRetry(ref, retries, delayMs) {
    retries  = retries  || 3;
    delayMs  = delayMs  || 900;
    for (var i = 0; i < retries; i++) {
      var doc = await ref.get();
      if (doc.exists) return doc;
      if (i < retries - 1) await new Promise(function(r){ setTimeout(r, delayMs); });
    }
    return null;
  }

  // Compute correct destination — mirrors buildDest in login/index/signup
  function buildDest(role, discipline) {
    if (role === 'superadmin') return '/superadmin/';
    if (role === 'admin')      return '/admin/';
    if (role === 'athlete')    return '/' + (discipline||'other') + '/athlete.html';
    if (role === 'coach' || role === 'assistantCoach') {
      var app = window.innerWidth <= 768 ? 'coach-mobile.html' : 'coach-desktop.html';
      return '/' + (discipline||'other') + '/' + app;
    }
    return '/login.html';
  }

  // Role + discipline → expected path check (prevents wrong-role or wrong-sport access)
  function allowedOnThisPage(role, discipline) {
    var path = window.location.pathname;
    if (role === 'superadmin') return path.indexOf('/superadmin/') === 0;
    if (role === 'admin')      return path.indexOf('/admin/')      === 0;
    // Coaches (head + assistant) and athletes must be inside their sport folder
    var sportFolder = '/' + (discipline||'other') + '/';
    if (role === 'coach' || role === 'assistantCoach') return path.indexOf(sportFolder) === 0;
    if (role === 'athlete') return path.indexOf(sportFolder) === 0;
    return false;
  }

  auth.onAuthStateChanged(async function(user) {
    if (!user) {
      window.location.href = '/login.html';
      return;
    }

    try {
      var userDoc = await getWithRetry(db.collection('users').doc(user.uid));

      if (!userDoc || !userDoc.exists) {
        await auth.signOut();
        window.location.href = '/login.html';
        return;
      }

      var ud   = userDoc.data();
      var role = ud.role;

      // Redirect if on wrong app or wrong sport folder
      if (!allowedOnThisPage(role, ud.discipline)) {
        window.location.href = buildDest(role, ud.discipline);
        return;
      }

      // Build ADA_USER — superset of all role fields
      window.ADA_USER = {
        uid:      user.uid,
        email:    ud.email    || user.email || '',
        name:     ud.name     || '',
        role:     role,
        orgId:    ud.orgId    || '',
        orgName:  ud.orgName  || '',
        teamId:   ud.teamId   || null,
        teamName: ud.teamName || '',
        // Roster assignment for coaches/staff — array of athlete uids, or null if unset
        assignedAthletes: Array.isArray(ud.assignedAthletes) ? ud.assignedAthletes : null,
        // Coach/staff context (discipline: kata/kumite/both, coachRole: Head Coach/etc.)
        discipline: ud.discipline || null,
        coachRole:  ud.coachRole  || null,
        inviteCode: ud.inviteCode  || null,
        coachId:    ud.coachId     || null,
        // Assistant-coach feature: assistantInviteCode + assistantInviteCodeCreatedAt
        // live on the HEAD coach's own doc (set by generateAssistantInviteCode in
        // functions/index.js); `assistants` is that same doc's array of linked
        // assistant uids. Both are null/empty for athletes, assistants themselves,
        // and any head coach who hasn't generated a code yet.
        assistantInviteCode: ud.assistantInviteCode || null,
        assistants: Array.isArray(ud.assistants) ? ud.assistants : [],
        // Per-account onboarding flag (Firestore-backed, NOT localStorage —
        // a browser-local flag would incorrectly apply to every account that
        // ever signs in on that browser, not just the one that dismissed it)
        onboarded:  ud.onboarded === true
      };

      // Expose db globally (coach-desktop.html uses window.db)
      window.db = db;

      overlay.remove();
      window.dispatchEvent(new CustomEvent('ada:ready', { detail: window.ADA_USER }));

    } catch (e) {
      console.error('Auth gate error:', e);
      overlay.remove();
      window.dispatchEvent(new CustomEvent('ada:ready', { detail: { error: true } }));
    }
  });
})();
