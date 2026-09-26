// Touch devices (phones and tablets) get the touch controls and a lighter
// renderer: pixel ratio 1, smaller particle pools and no dynamic point lights.
// `?touch=1` in the URL forces touch mode for the rest of the browser session
// (for testing on a desktop); `?touch=0` turns that off.

function forced() {
  try {
    const q = new URLSearchParams(location.search).get('touch');
    if (q != null) sessionStorage.setItem('force-touch', q);
    return sessionStorage.getItem('force-touch') === '1';
  } catch {
    return false;
  }
}

export const TOUCH = forced() || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
export const LOW = TOUCH;
