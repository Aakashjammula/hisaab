// Two-step sign-in: email → 6-digit code. The session is an HttpOnly cookie set by the server.
import { api } from './api.js';
import { $ } from './ui.js';

const RESEND_SECONDS = 60;
let email = '', resendTimer = null, onSignedIn = () => {};

const emailForm = () => $('#login-email-form');
const codeForm = () => $('#login-code-form');

function showError(msg) {
  const el = $('#login-error');
  el.textContent = msg ?? '';
  el.hidden = !msg;
}

function busy(form, on) {
  form.querySelector('[type=submit]').disabled = on;
}

function startResendCooldown(seconds = RESEND_SECONDS) {
  const btn = $('[data-action=login-resend]');
  clearInterval(resendTimer);
  let left = seconds;
  const tick = () => {
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Resend in ${left}s` : 'Resend code';
    left--;
    if (left < 0) clearInterval(resendTimer);
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

function showStep(step) {
  emailForm().hidden = step !== 'email';
  codeForm().hidden = step !== 'code';
  showError(null);
  (step === 'email' ? emailForm().elements.email : codeForm().elements.code).focus();
}

async function sendCode() {
  try {
    await api.requestCode(email);
    $('#login-sent-to').textContent = email;
    codeForm().elements.code.value = '';
    showStep('code');
    startResendCooldown();
  } catch (err) {
    showError(err.message);
    if (err.status === 429) startResendCooldown(30);
  }
}

export function initLogin(options) {
  onSignedIn = options.onSignedIn;

  emailForm().addEventListener('submit', async e => {
    e.preventDefault();
    const value = emailForm().elements.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return showError('Enter a valid email address');
    email = value.toLowerCase();
    busy(emailForm(), true);
    await sendCode();
    busy(emailForm(), false);
  });

  // keep only digits, submit automatically at 6
  codeForm().elements.code.addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (e.target.value.length === 6) codeForm().requestSubmit();
  });

  codeForm().addEventListener('submit', async e => {
    e.preventDefault();
    const code = codeForm().elements.code.value;
    if (code.length !== 6) return showError('Enter the 6-digit code from the email');
    busy(codeForm(), true);
    try {
      const me = await api.verifyCode(email, code);
      clearInterval(resendTimer);
      onSignedIn(me);
    } catch (err) {
      showError(err.message);
      codeForm().elements.code.select();
    } finally {
      busy(codeForm(), false);
    }
  });

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'login-change-email') showStep('email');
    if (a === 'login-resend') sendCode();
  });
}

export function showLogin() {
  document.body.classList.add('signed-out');
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== 'v-login';
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  showStep(email && !codeForm().hidden ? 'code' : 'email');
}

export function hideLogin() {
  document.body.classList.remove('signed-out');
  $('#v-login').hidden = true;
}
