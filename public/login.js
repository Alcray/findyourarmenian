const form = document.querySelector('#login-form');
const passwordInput = document.querySelector('#password');
const button = document.querySelector('#login-button');
const statusEl = document.querySelector('#login-status');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  statusEl.textContent = '';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Sign-in failed.');
    passwordInput.value = '';
    window.location.replace('/admin');
  } catch (error) {
    statusEl.textContent = error.message || 'Sign-in failed.';
    passwordInput.select();
  } finally {
    button.disabled = false;
  }
});
