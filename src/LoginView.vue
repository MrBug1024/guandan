<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { refreshSession } from './auth';
const router = useRouter(),
  username = ref(''),
  password = ref(''),
  error = ref(''),
  pending = ref(false);
async function login() {
  pending.value = true;
  error.value = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error ?? '登录失败');
    password.value = '';
    await refreshSession();
    await router.replace('/studio');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <main class="login-page">
    <section class="login-story">
      <div class="login-club">g <span>GUANDAN / AI CLUB</span></div>
      <span class="eyebrow">FOUR MINDS. ONE TABLE.</span>
      <h2>一场牌局，<br />四种思考。</h2>
      <p>让不同的 AI 围桌而坐。<br />从每次出牌里，发现策略与默契。</p>
      <div class="login-deck" aria-hidden="true">
        <span>♠<b>A</b></span
        ><span>♥<b>2</b></span
        ><span>♣<b>K</b></span>
      </div>
      <small>规则引擎裁判 · 独立决策 · 沉浸观战</small>
    </section>
    <form class="login-card" @submit.prevent="login">
      <div class="login-mark">会员工作室</div>
      <p class="login-eyebrow">YOUR WORKSPACE</p>
      <h1>欢迎回来</h1>
      <p>管理员登录后管理模型、赛事与直播。</p>
      <label
        >管理员账号<input v-model="username" autocomplete="username" required maxlength="80"
      /></label>
      <label
        >密码<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="200"
      /></label>
      <p v-if="error" role="alert" class="login-error">{{ error }}</p>
      <button class="primary" :disabled="pending">
        {{ pending ? '正在登录…' : '登录工作室' }}
      </button>
      <small>观众无需登录，请使用管理员分享的观战链接。</small>
    </form>
  </main>
</template>
<style scoped>
.login-page {
  margin: 0;
  width: 100%;
  max-width: none;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: radial-gradient(ellipse at 50% 0%, #294238, #101925 70%);
  color: #e6edf2;
}
.login-card {
  width: min(420px, 100%);
  padding: 36px;
  border: 1px solid #586f7055;
  border-radius: 24px;
  background: #14202be8;
  box-shadow: 0 30px 90px #0004;
  display: grid;
  gap: 16px;
}
.login-mark {
  font: 64px Georgia;
  color: #dec69d;
}
.login-eyebrow {
  letter-spacing: 3px;
  font-size: 10px;
  color: #c3b59b;
}
.login-card h1 {
  margin: 0;
  font-size: 26px;
}
.login-card p,
.login-card small {
  color: #a7b8c7;
  line-height: 1.7;
  margin: 0;
}
.login-card label {
  display: grid;
  gap: 8px;
  font-size: 13px;
}
.login-card input {
  width: 100%;
  padding: 12px;
  border: 1px solid #536e7b;
  border-radius: 10px;
  background: #0e1923;
  color: #fff;
}
.login-card button {
  padding: 12px;
  border-radius: 12px;
}
.login-card .login-error {
  color: #ff9292;
}
.login-card small {
  font-size: 11px;
}
</style>
