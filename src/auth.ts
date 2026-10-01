import { ref } from 'vue';
export const admin = ref(false);
export const sharePath = ref('');
export async function refreshSession() {
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    const session = await response.json();
    admin.value = session.authenticated === true;
    sharePath.value = admin.value ? session.sharePath : '';
  } catch {
    admin.value = false;
    sharePath.value = '';
  }
  return admin.value;
}
