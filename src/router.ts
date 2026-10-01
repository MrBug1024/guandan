import { createRouter, createWebHistory } from 'vue-router';
import StudioView from './StudioView.vue';
import ArenaView from './ArenaView.vue';
import StudioLayout from './StudioLayout.vue';
import LoginView from './LoginView.vue';
import { refreshSession } from './auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    { path: '/watch/:share', name: 'watch', component: ArenaView },
    {
      path: '/',
      redirect: (to) => (to.query.broadcast ? { path: '/arena', query: to.query } : '/studio'),
    },
    {
      path: '/studio',
      component: StudioLayout,
      children: [
        { path: '', name: 'lobby', component: StudioView },
        { path: 'models', name: 'config', component: StudioView },
        { path: 'broadcast', name: 'live', component: StudioView },
        { path: 'replays', name: 'inspect', component: StudioView },
      ],
    },
    { path: '/arena', name: 'arena', component: ArenaView },
    { path: '/:pathMatch(.*)*', redirect: '/studio' },
  ],
});
router.beforeEach(async (to) => {
  if (to.name === 'watch') return true;
  const authenticated = await refreshSession();
  if (to.name === 'login') return authenticated ? '/studio' : true;
  return authenticated ? true : '/login';
});
