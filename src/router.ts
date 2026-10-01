import { createRouter, createWebHistory } from 'vue-router';
import StudioView from './StudioView.vue';
import ArenaView from './ArenaView.vue';
import StudioLayout from './StudioLayout.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
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
