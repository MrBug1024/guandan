import { onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue';
import type { PublicGame } from '../shared/types';
import { arenaSnapshot, selectArenaCue, type ArenaCue, type ArenaSnapshot } from './arena-events';

export function useArenaShow(game: ComputedRef<PublicGame | undefined>) {
  const cue = ref<ArenaCue>();
  const reducedMotion = ref(false);
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const updateMotion = () => (reducedMotion.value = motionQuery.matches);
  updateMotion();
  let previous: ArenaSnapshot | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  watch(
    game,
    (current) => {
      if (!current) {
        clearTimeout(expiry);
        cue.value = undefined;
        previous = undefined;
        return;
      }
      const next = selectArenaCue(current, previous);
      const snapshot = arenaSnapshot(current);
      const contextChanged = previous?.id !== snapshot.id || previous?.round !== snapshot.round;
      const advanced = previous && snapshot.seq !== previous.seq;
      const backwards = previous && snapshot.seq < previous.seq;
      const newPlay = advanced && current.history.at(-1)?.move?.kind !== 'pass';
      if (next || contextChanged || backwards || newPlay) {
        clearTimeout(expiry);
        cue.value = next;
        if (next)
          expiry = setTimeout(() => {
            cue.value = undefined;
          }, next.duration);
      }
      previous = snapshot;
    },
    { immediate: true },
  );
  onMounted(() => motionQuery.addEventListener('change', updateMotion));
  onBeforeUnmount(() => {
    clearTimeout(expiry);
    motionQuery.removeEventListener('change', updateMotion);
  });
  return { cue, reducedMotion };
}
