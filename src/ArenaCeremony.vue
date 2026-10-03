<script setup lang="ts">
import { computed } from 'vue';
import { cardName, rankName, type Card, type PublicGame } from '../shared/types';
import { isRoundOver } from './arena-events';
const props = defineProps<{
  game: PublicGame;
  now: number;
  countdown: number | null;
  broadcast: boolean;
  pending: boolean;
  reducedMotion: boolean;
}>();
const emit = defineEmits<{ control: [action: string] }>();
const over = computed(() => isRoundOver(props.game));
const tribute = computed(
  () => !over.value && !!props.game.tributeUntil && props.now < props.game.tributeUntil,
);
const settlement = computed(() => props.game.settlement);
const winners = computed(() =>
  props.game.agents
    .map((agent, seat) => ({ ...agent, seat }))
    .filter((agent) => agent.seat % 2 === props.game.winner),
);
const isRed = (card: Card) => ['H', 'D'].includes(card.suit) || card.rank === 16;
const tributePhase = computed(() =>
  Math.max(0, Math.min(1, 1 - ((props.game.tributeUntil ?? props.now) - props.now) / 4000)),
);
</script>
<template>
  <Transition name="ceremony">
    <section
      v-if="over"
      :key="game.id + ':' + game.round"
      class="round-result arena-settlement"
      :class="{ 'motion-reduced': reducedMotion, champion: game.status === 'match-over' }"
      aria-label="本局结算"
      aria-live="polite"
    >
      <div class="settlement-medal" aria-hidden="true">
        <svg viewBox="0 0 64 64" fill="none">
          <path
            d="M20 10h24v16c0 10-5 16-12 16S20 36 20 26V10Z"
            stroke="currentColor"
            stroke-width="2.5"
          />
          <path
            d="M20 15H10v6c0 8 5 12 12 12m22-18h10v6c0 8-5 12-12 12M32 42v10m-11 3h22"
            stroke="currentColor"
            stroke-width="2.5"
          />
          <path
            d="m32 17 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2-4.5-4.4 6.2-.9L32 17Z"
            fill="currentColor"
          />
        </svg>
      </div>
      <span class="result-eyebrow">{{
        game.status === 'match-over'
          ? 'MATCH CHAMPIONS'
          : 'VICTORY · ROUND ' + String(game.round).padStart(2, '0')
      }}</span>
      <h2>
        {{
          settlement?.passedA
            ? '巅峰夺冠'
            : settlement?.partnerPlace === 2
              ? '双下！完美配合'
              : '胜利属于你们'
        }}
      </h2>
      <div class="settlement-winners">
        <span v-for="winner in winners" :key="winner.seat"
          ><i :class="'seat-' + winner.seat"></i>{{ winner.name }}</span
        ><small>WINNERS</small>
      </div>
      <div v-if="settlement" class="upgrade-stage">
        <template v-if="settlement.passedA"
          ><span class="upgrade-caption">成功过 A</span
          ><strong class="champion-title">本场冠军</strong></template
        >
        <template v-else
          ><span class="upgrade-caption">{{
            settlement.upgrade ? '晋级时刻' : '本队当前等级'
          }}</span>
          <div class="upgrade-ranks">
            <span>{{ rankName(settlement.from) }}</span
            ><svg viewBox="0 0 40 20" aria-hidden="true">
              <path
                d="M1 10h34M26 2l9 8-9 8"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              /></svg
            ><strong>{{ rankName(settlement.to) }}</strong
            ><b v-if="settlement.upgrade">+{{ settlement.upgrade }} 级</b>
          </div></template
        >
      </div>
      <p v-if="settlement" class="settlement-explanation">
        <template v-if="settlement.passedA">头游与队友成功过 A，赢得本场比赛。</template
        ><template v-else
          >头游 + {{ ['', '头游', '二游', '三游', '末游'][settlement.partnerPlace]
          }}{{
            settlement.upgrade ? ` · 升 ${settlement.upgrade} 级` : ' · 本局结算完成'
          }}</template
        ><strong v-if="settlement.failedA"
          >打 A 方本次过 A 未成功，累计 {{ settlement.failedA }} 次。</strong
        ><strong v-if="settlement.demotedTeam !== undefined"
          >{{ game.agents[settlement.demotedTeam].name }}与队友三次过 A 未成功，降回 2。</strong
        >
      </p>
      <div class="finish-order">
        <div
          v-for="(seat, index) in game.finished"
          :key="seat"
          :class="{ 'finish-winner': seat % 2 === game.winner }"
        >
          <small>{{
            index >= 2 && game.finished[0]! % 2 === game.finished[1]! % 2
              ? '双下'
              : ['头游', '二游', '三游', '末游'][index]
          }}</small
          ><strong>{{ game.agents[seat].name }}</strong
          ><span>{{ seat % 2 === game.winner ? '欢呼庆祝' : '下局再战' }}</span>
        </div>
      </div>
      <div class="settlement-next">
        <template v-if="countdown !== null"
          ><span class="next-round-clock">{{ countdown }}</span
          ><span>下一局即将开始<small>升级已结算 · 准备贡牌仪式</small></span></template
        ><span v-else>{{
          game.status === 'match-over' ? '本场比赛结束 · 感谢观赛' : '自动续局已暂停'
        }}</span>
      </div>
      <button
        v-if="!broadcast && game.status === 'round-over'"
        class="ghost"
        :disabled="pending"
        @click="emit('control', countdown !== null ? 'pause' : 'start')"
      >
        {{ countdown !== null ? '暂停连续对局' : '继续下一局 →' }}
      </button>
      <button
        v-if="!broadcast && game.status === 'match-over'"
        class="primary"
        :disabled="pending"
        @click="emit('control', 'reset')"
      >
        重新比赛
      </button>
    </section>
    <section
      v-else-if="tribute"
      :key="game.id + ':' + game.round + ':tribute'"
      class="tribute-ceremony arena-tribute"
      :class="{
        'anti-tribute': game.tributeKind === 'anti',
        'tribute-receiving': tributePhase > 0.3,
        'tribute-returning': tributePhase > 0.57,
        'motion-reduced': reducedMotion,
      }"
      aria-live="polite"
    >
      <span class="result-eyebrow"
        >{{ game.tributeKind === 'anti' ? 'TRIBUTE DEFENDED' : 'TRIBUTE CEREMONY' }} · ROUND
        {{ String(game.round).padStart(2, '0') }}</span
      >
      <h3>
        {{
          game.tributeKind === 'anti'
            ? '双王护体 · 抗贡成功'
            : game.tributeKind === 'double'
              ? '双贡礼遇'
              : '贡牌时刻'
        }}
      </h3>
      <div v-if="game.tributeKind === 'anti'" class="anti-tribute-seal">
        <svg viewBox="0 0 80 88" aria-hidden="true">
          <path
            d="M40 5 70 16v25c0 20-15 31-30 41C25 72 10 61 10 41V16L40 5Z"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          />
          <path d="m23 34 10 9 7-19 7 19 10-9-5 24H28l-5-24Z" fill="currentColor" /></svg
        ><span>大王 × 2</span>
      </div>
      <p v-if="game.tributeKind === 'anti'">进贡方合计持两张大王，免进贡、免还贡。</p>
      <template v-else>
        <div class="tribute-stages">
          <span :class="{ current: tributePhase <= 0.3 }">01 进贡</span
          ><span :class="{ current: tributePhase > 0.3 && tributePhase <= 0.57 }">02 接贡</span
          ><span :class="{ current: tributePhase > 0.57 }">03 还贡</span>
        </div>
        <div v-for="step in game.tributeSteps" :key="step.donor" class="tribute-flight-row">
          <div class="tribute-person">
            <span>进贡方</span><strong>{{ game.agents[step.donor].name }}</strong>
          </div>
          <div class="tribute-flight-lane">
            <div class="tribute-flight-card offered" :class="{ red: isRed(step.offered) }">
              {{ cardName(step.offered) }}<small>进贡</small>
            </div>
            <div class="tribute-flight-card returned" :class="{ red: isRed(step.returned) }">
              {{ cardName(step.returned) }}<small>还贡</small>
            </div>
            <svg viewBox="0 0 160 12" aria-hidden="true">
              <path
                d="M0 6h152m-8-5 8 5-8 5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              />
            </svg>
          </div>
          <div class="tribute-person">
            <span>接贡方</span><strong>{{ game.agents[step.receiver].name }}</strong>
          </div>
        </div>
      </template>
      <footer>
        第 {{ game.round }} 局 · 打 {{ rankName(game.level) }}<br />{{
          game.agents[game.turn].name
        }}先出牌 ·
        {{ Math.max(0, Math.ceil(((game.tributeUntil ?? now) - now) / 1000)) }} 秒后进入对局
      </footer>
    </section>
  </Transition>
</template>
