// The web's copy of the profile rules.
//
// A mirror of native-app/src/profileEdit.ts, compared against it in
// test/profileEdit.test.js. The reasoning — why a rename needs no password,
// and why the number of changes left is said before the change rather than
// after it — is written out in full there.
(function (global) {
  var USERNAME_CHANGE_LIMIT = 2;

  function changesLeftText(left) {
    if (left === null || left === undefined) return 'Checking how many changes you have left…';
    if (left <= 0) return 'You have used all your username changes. This name can no longer be changed.';
    return 'Your username can only be changed ' + left + ' more ' + (left === 1 ? 'time' : 'times')
      + '. People who know your old @name will no longer find you by it.';
  }

  function canRename(left) { return typeof left === 'number' && left > 0; }

  function renameWorthDoing(current, next) {
    var a = String(current || '').trim();
    var b = String(next || '').trim();
    return !!b && a.toLowerCase() !== b.toLowerCase();
  }

  function renamedText(left) {
    if (typeof left !== 'number') return 'Username updated';
    return left > 0
      ? 'Username updated — ' + left + ' ' + (left === 1 ? 'change' : 'changes') + ' left'
      : 'Username updated — that was your last change';
  }

  function passwordProblem(o) {
    if (!o.newPassword) return 'Enter the new password';
    if (!o.currentPassword) return 'Your current password is required to set a new one';
    if (o.confirmPassword !== undefined && o.newPassword !== o.confirmPassword) {
      return 'The two new passwords are not the same';
    }
    return null;
  }

  global.ProfileEdit = {
    USERNAME_CHANGE_LIMIT: USERNAME_CHANGE_LIMIT,
    changesLeftText: changesLeftText,
    canRename: canRename,
    renameWorthDoing: renameWorthDoing,
    renamedText: renamedText,
    passwordProblem: passwordProblem,
  };
})(typeof window !== 'undefined' ? window : this);
