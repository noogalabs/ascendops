/** Shared default-branch rule for member update preflight and the build guard. */
export function isDefaultBranch(branch) {
  return branch === 'main';
}
