'use client';

import type {
  AdventureProfile,
  AdventureSkill,
  BattleResolution,
  DailyQuest,
  DungeonFloorSummary,
  DungeonMap,
  DungeonRunState,
  EquipmentSlot,
  Inventory,
  InventoryItem,
} from '@lexloop/types';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft,
  Backpack,
  BookOpenCheck,
  Check,
  ChevronRight,
  Coins,
  Footprints,
  Gem,
  Heart,
  LoaderCircle,
  LockKeyhole,
  Map,
  Shield,
  Sparkles,
  Swords,
  Target,
  TentTree,
  Trophy,
  WandSparkles,
  X,
} from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { request, userFacingError, type Session } from '../../lib/api';
import styles from './adventure-page.module.css';

type View = 'map' | 'character' | 'inventory';
type BattleFx = { key: number; grade: string; damage: number; received: number } | null;
type BattleUi = {
  busy: boolean;
  selectedSkill: string | null;
  answer: string[];
  feedback: BattleResolution['feedback'] | null;
  fx: BattleFx;
  loot: InventoryItem | null;
};
type BattleEvent =
  | { type: 'answer'; value: string[] }
  | { type: 'skill'; value: string | null }
  | { type: 'submit' }
  | { type: 'resolved'; value: BattleResolution; loot: InventoryItem | null }
  | { type: 'clearFx' }
  | { type: 'failed' }
  | { type: 'reset' };

const initialBattle: BattleUi = {
  busy: false,
  selectedSkill: null,
  answer: [],
  feedback: null,
  fx: null,
  loot: null,
};
function battleReducer(state: BattleUi, event: BattleEvent): BattleUi {
  if (event.type === 'answer') return { ...state, answer: event.value, feedback: null };
  if (event.type === 'skill') return { ...state, selectedSkill: event.value };
  if (event.type === 'submit') return { ...state, busy: true, feedback: null };
  if (event.type === 'resolved')
    return {
      busy: false,
      selectedSkill: null,
      answer: [],
      feedback: event.value.feedback,
      fx: {
        key: Date.now(),
        grade: event.value.grade,
        damage: event.value.damageDealt,
        received: event.value.damageReceived,
      },
      loot: event.loot,
    };
  if (event.type === 'clearFx') return { ...state, fx: null, loot: null };
  if (event.type === 'failed') return { ...state, busy: false, loot: null };
  return initialBattle;
}

export function AdventurePage({ session, onBack }: { session: Session; onBack: () => void }) {
  const [profile, setProfile] = useState<AdventureProfile | null>(null);
  const [map, setMap] = useState<DungeonMap | null>(null);
  const [run, setRun] = useState<DungeonRunState | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [quests, setQuests] = useState<DailyQuest[]>([]);
  const [view, setView] = useState<View>('map');
  const [routeFloor, setRouteFloor] = useState<DungeonFloorSummary | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [nextProfile, nextMap, active, nextInventory, nextQuests] = await Promise.all([
        request<AdventureProfile>('/adventure/profile', {}, session.accessToken),
        request<DungeonMap>('/adventure/dungeons', {}, session.accessToken),
        request<DungeonRunState | null>('/adventure/runs/active', {}, session.accessToken),
        request<Inventory>('/adventure/inventory', {}, session.accessToken),
        request<DailyQuest[]>('/adventure/daily-quests', {}, session.accessToken),
      ]);
      setProfile(nextProfile);
      setMap(nextMap);
      setRun(active);
      setInventory(nextInventory);
      setQuests(nextQuests);
    } catch (error) {
      setNotice(userFacingError(error, '冒险手账暂时打不开，请稍后再试。'));
    } finally {
      setBusy(false);
    }
  }, [session.accessToken]);
  useEffect(() => {
    void load();
  }, [load]);

  async function chooseClass(classKey: string, advancement = false) {
    setBusy(true);
    setNotice('');
    try {
      setProfile(
        await request<AdventureProfile>(
          advancement ? '/adventure/class-advancements' : '/adventure/profile/class',
          { method: 'POST', body: JSON.stringify({ classKey }) },
          session.accessToken,
        ),
      );
    } catch (error) {
      setNotice(userFacingError(error));
    } finally {
      setBusy(false);
    }
  }

  async function startRun(floor: DungeonFloorSummary, durationMinutes: 5 | 10 | 15) {
    setBusy(true);
    setNotice('');
    try {
      setRun(
        await request<DungeonRunState>(
          '/adventure/runs',
          { method: 'POST', body: JSON.stringify({ floorId: floor.id, durationMinutes }) },
          session.accessToken,
        ),
      );
      setRouteFloor(null);
    } catch (error) {
      setNotice(userFacingError(error));
    } finally {
      setBusy(false);
    }
  }

  if (busy && !profile) return <AdventureLoading onBack={onBack} />;
  if (!profile) return <AdventureLoading onBack={onBack} message={notice} />;
  if (!profile.currentClass)
    return (
      <ClassSelection
        profile={profile}
        busy={busy}
        notice={notice}
        onBack={onBack}
        onChoose={(key) => void chooseClass(key)}
      />
    );
  if (run)
    return (
      <BattlePage
        run={run}
        session={session}
        onRun={setRun}
        onFinished={() => {
          setRun(null);
          void load();
        }}
      />
    );

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <button onClick={onBack} aria-label="返回词环">
          <ArrowLeft />
        </button>
        <div>
          <small>LEXLOOP ADVENTURE LOG</small>
          <strong>地下词环</strong>
        </div>
        <nav aria-label="冒险菜单">
          <button className={view === 'map' ? styles.active : ''} onClick={() => setView('map')}>
            <Map /> 地牢
          </button>
          <button
            className={view === 'character' ? styles.active : ''}
            onClick={() => setView('character')}
          >
            <Swords /> 角色
          </button>
          <button
            className={view === 'inventory' ? styles.active : ''}
            onClick={() => setView('inventory')}
          >
            <Backpack /> 背包 <b>{inventory?.items.length ?? 0}</b>
          </button>
        </nav>
      </header>
      {notice && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}
      <section className={styles.hero}>
        <div>
          <p>第 {profile.highestFloor + 1} 层远征准备</p>
          <h1>{profile.currentClass.name}，把记住的词变成真正的力量。</h1>
          <span>每一次有效召回都会点亮地图。选择题只能探路，拼写和造句才能真正征服地牢。</span>
        </div>
        <ProfileCard profile={profile} />
      </section>
      {view === 'map' && (
        <>
          <QuestBoard
            quests={quests}
            onClaim={async (id) => {
              try {
                setQuests(
                  await request<DailyQuest[]>(
                    `/adventure/daily-quests/${id}/claim`,
                    { method: 'POST' },
                    session.accessToken,
                  ),
                );
                const p = await request<AdventureProfile>(
                  '/adventure/profile',
                  {},
                  session.accessToken,
                );
                setProfile(p);
              } catch (error) {
                setNotice(userFacingError(error));
              }
            }}
          />
          <DungeonBoard map={map} onSelect={setRouteFloor} />
        </>
      )}
      {view === 'character' && (
        <CharacterSheet
          profile={profile}
          busy={busy}
          onAdvance={(key) => void chooseClass(key, true)}
          onUnlock={async (id) => {
            setBusy(true);
            try {
              setProfile(
                await request<AdventureProfile>(
                  `/adventure/skills/${id}/unlock`,
                  { method: 'POST' },
                  session.accessToken,
                ),
              );
            } catch (error) {
              setNotice(userFacingError(error));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {view === 'inventory' && (
        <InventorySheet
          inventory={inventory}
          onEquip={async (id) => {
            try {
              const next = await request<Inventory>(
                `/adventure/equipment/${id}/equip`,
                { method: 'POST', body: '{}' },
                session.accessToken,
              );
              setInventory(next);
            } catch (error) {
              setNotice(userFacingError(error));
            }
          }}
        />
      )}
      <AnimatePresence>
        {routeFloor && (
          <RoutePicker
            floor={routeFloor}
            onClose={() => setRouteFloor(null)}
            onStart={(minutes) => void startRun(routeFloor, minutes)}
          />
        )}
      </AnimatePresence>
    </main>
  );
}

function ClassSelection({
  profile,
  busy,
  notice,
  onBack,
  onChoose,
}: {
  profile: AdventureProfile;
  busy: boolean;
  notice: string;
  onBack: () => void;
  onChoose: (key: string) => void;
}) {
  const icons = [Shield, WandSparkles, Target, Sparkles];
  const classes = profile.availableClasses.filter((item) => item.tier === 0);
  return (
    <main className={styles.classPage}>
      <button className={styles.back} onClick={onBack}>
        <ArrowLeft /> 返回词环
      </button>
      <header>
        <small>CHOOSE YOUR CALLING</small>
        <h1>在第一页，写下你的职业。</h1>
        <p>职业决定战斗节奏，但不会替你答题。所有冒险者都必须用真实的英语能力前进。</p>
      </header>
      {notice && <div className={styles.notice}>{notice}</div>}
      <section className={styles.classGrid}>
        {classes.map((item, index) => {
          const Icon = icons[index];
          return (
            <motion.button
              whileHover={{ y: -6 }}
              whileTap={{ scale: 0.98 }}
              key={item.id}
              disabled={busy}
              onClick={() => onChoose(item.key)}
            >
              <i>
                <Icon />
              </i>
              <small>ROLE 0{index + 1}</small>
              <h2>{item.name}</h2>
              <p>{item.description}</p>
              <span>
                选择职业 <ChevronRight />
              </span>
            </motion.button>
          );
        })}
      </section>
    </main>
  );
}

function ProfileCard({ profile }: { profile: AdventureProfile }) {
  const previous = (profile.level - 1) * profile.level * 50;
  const progress = Math.max(
    0,
    Math.min(
      100,
      ((profile.experience - previous) / Math.max(1, profile.experienceToNextLevel - previous)) *
        100,
    ),
  );
  return (
    <aside className={styles.profileCard}>
      <div className={styles.avatar}>
        <Swords />
      </div>
      <div>
        <small>{profile.currentClass?.combatRole}</small>
        <strong>
          Lv.{profile.level} {profile.currentClass?.name}
        </strong>
        <i>
          <b style={{ width: `${progress}%` }} />
        </i>
        <span>
          {profile.experience} / {profile.experienceToNextLevel} EXP
        </span>
      </div>
      <footer>
        <span>
          <Coins /> {profile.gold}
        </span>
        <span>
          <Gem /> {profile.materials}
        </span>
        <span>
          <Sparkles /> {profile.skillPoints}
        </span>
      </footer>
    </aside>
  );
}

function QuestBoard({ quests, onClaim }: { quests: DailyQuest[]; onClaim: (id: string) => void }) {
  return (
    <section className={styles.questBoard}>
      <header>
        <div>
          <BookOpenCheck />
          <span>
            <small>DAILY BOUNTIES</small>
            <h2>今日悬赏</h2>
          </span>
        </div>
        <p>旧地牢正在重新长出宝藏</p>
      </header>
      <div>
        {quests.map((quest, index) => (
          <article key={quest.id}>
            <b>{index + 1}</b>
            <span>
              <strong>{quest.title}</strong>
              <small>{quest.description}</small>
              <i>
                <em
                  style={{ width: `${Math.min(100, (quest.progress / quest.targetCount) * 100)}%` }}
                />
              </i>
            </span>
            <div>
              <small>
                {Math.min(quest.progress, quest.targetCount)} / {quest.targetCount}
              </small>
              <button disabled={!quest.claimable} onClick={() => onClaim(quest.id)}>
                {quest.claimedAt ? (
                  <>
                    <Check /> 已领取
                  </>
                ) : quest.claimable ? (
                  '领取'
                ) : (
                  `+${quest.reward.materials} 材料`
                )}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DungeonBoard({
  map,
  onSelect,
}: {
  map: DungeonMap | null;
  onSelect: (floor: DungeonFloorSummary) => void;
}) {
  if (!map?.book)
    return (
      <section className={styles.empty}>
        <Map />
        <h2>还没有可以展开的地牢</h2>
        <p>先返回词环选择一本默认词汇表，系统会按每 12 个词生成一层地图。</p>
      </section>
    );
  return (
    <section className={styles.dungeonBoard}>
      <header>
        <div>
          <small>CURRENT BOOK DUNGEON</small>
          <h2>{map.book.title}</h2>
        </div>
        <span>
          {map.floors.filter((item) => item.completed).length} / {map.floors.length} 已征服
        </span>
      </header>
      <div className={styles.floorTrail}>
        {map.floors.map((floor, index) => (
          <motion.button
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(index, 10) * 0.035 }}
            key={floor.id}
            disabled={floor.locked}
            className={`${floor.completed ? styles.complete : ''} ${floor.bossUnlocked ? styles.boss : ''}`}
            onClick={() => onSelect(floor)}
          >
            <span className={styles.floorNo}>
              {floor.locked ? (
                <LockKeyhole />
              ) : floor.completed ? (
                <Trophy />
              ) : (
                `${floor.floorNumber}F`
              )}
            </span>
            <div>
              <small>
                {floor.cefrLevel} · {floor.targetCount} 个学习目标
              </small>
              <strong>{floor.title}</strong>
              <div className={styles.meters}>
                <label>
                  探索{' '}
                  <i>
                    <b style={{ width: `${floor.exploration}%` }} />
                  </i>
                  <em>{floor.exploration}%</em>
                </label>
                <label>
                  掌握{' '}
                  <i>
                    <b style={{ width: `${floor.mastery}%` }} />
                  </i>
                  <em>{floor.mastery}%</em>
                </label>
              </div>
            </div>
            <ChevronRight />
          </motion.button>
        ))}
      </div>
    </section>
  );
}

function RoutePicker({
  floor,
  onClose,
  onStart,
}: {
  floor: DungeonFloorSummary;
  onClose: () => void;
  onStart: (minutes: 5 | 10 | 15) => void;
}) {
  return (
    <motion.div
      className={styles.modalLayer}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <button className={styles.scrim} onClick={onClose} aria-label="关闭路线选择" />
      <motion.section
        initial={{ scale: 0.94, y: 18 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 12 }}
        className={styles.routePicker}
      >
        <header>
          <div>
            <small>CHOOSE A ROUTE</small>
            <h2>{floor.title}</h2>
            <p>路线越长，房间与学习证据越多，也更容易遇到营地。</p>
          </div>
          <button onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </header>
        <div>
          {([5, 10, 15] as const).map((minutes) => (
            <button key={minutes} onClick={() => onStart(minutes)}>
              <span>
                <Footprints />
              </span>
              <strong>{minutes} 分钟</strong>
              <small>
                {minutes === 5
                  ? '3 个房间 · 短途'
                  : minutes === 10
                    ? '6 个房间 · 标准'
                    : '9 个房间 · 深入'}
              </small>
              <ChevronRight />
            </button>
          ))}
        </div>
        {floor.bossUnlocked && (
          <p className={styles.bossNote}>
            <Trophy /> 首领已现身：最后一个房间将检验至少 6 次表达。
          </p>
        )}
      </motion.section>
    </motion.div>
  );
}

function BattlePage({
  run,
  session,
  onRun,
  onFinished,
}: {
  run: DungeonRunState;
  session: Session;
  onRun: (run: DungeonRunState) => void;
  onFinished: () => void;
}) {
  const [ui, dispatch] = useReducer(battleReducer, initialBattle);
  const [error, setError] = useState('');
  const pendingAction = useRef<{ challengeId: string; actionId: string } | null>(null);
  const challenge = run.challenge;
  const currentRoom = run.rooms.find((item) => item.position === run.currentRoom);
  const startedAt = useMemo(() => Date.now(), [challenge?.id]);
  useEffect(() => {
    if (!ui.fx) return;
    const timer = window.setTimeout(() => dispatch({ type: 'clearFx' }), 900);
    return () => window.clearTimeout(timer);
  }, [ui.fx]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!challenge || !ui.answer.length || ui.busy) return;
    dispatch({ type: 'submit' });
    setError('');
    const clientActionId =
      pendingAction.current?.challengeId === challenge.id
        ? pendingAction.current.actionId
        : crypto.randomUUID();
    pendingAction.current = { challengeId: challenge.id, actionId: clientActionId };
    try {
      const result = await request<BattleResolution>(
        `/adventure/runs/${run.id}/actions`,
        {
          method: 'POST',
          body: JSON.stringify({
            clientActionId,
            skillId: ui.selectedSkill,
            answer: ui.answer,
            responseTimeMs: Date.now() - startedAt,
          }),
        },
        session.accessToken,
      );
      const dropped =
        result.run.loot.length > run.loot.length ? (result.run.loot.at(-1) ?? null) : null;
      pendingAction.current = null;
      onRun(result.run);
      dispatch({ type: 'resolved', value: result, loot: dropped });
    } catch (reason) {
      setError(userFacingError(reason));
      dispatch({ type: 'failed' });
    }
  }
  if (run.status !== 'ACTIVE') return <RunResult run={run} onDone={onFinished} />;
  return (
    <main className={styles.battlePage}>
      <header>
        <button onClick={() => history.back()}>
          <ArrowLeft /> 离开战斗页
        </button>
        <div>
          <small>{run.floor.cefrLevel} DUNGEON</small>
          <strong>{run.floor.title}</strong>
        </div>
        <span>
          房间 {run.currentRoom + 1} / {run.roomCount}
        </span>
      </header>
      <nav className={styles.roomTrack}>
        {run.rooms.map((room) => (
          <i
            key={room.id}
            className={
              room.status === 'CLEARED' ? styles.done : room.status === 'ACTIVE' ? styles.here : ''
            }
          >
            {room.status === 'CLEARED' ? <Check /> : room.position + 1}
          </i>
        ))}
      </nav>
      <section className={styles.arena}>
        <div className={styles.playerPane}>
          <div className={styles.combatName}>
            <span>冒险者</span>
            <strong>
              HP {run.playerHp}/{run.playerMaxHp}
            </strong>
          </div>
          <i className={styles.hp}>
            <b style={{ width: `${(run.playerHp / run.playerMaxHp) * 100}%` }} />
          </i>
          <div className={styles.heroDoodle}>
            <Shield />
            <Swords />
          </div>
          <div className={styles.resource}>
            {Array.from({ length: 5 }, (_, index) => (
              <i className={index < run.resource ? styles.filled : ''} key={index} />
            ))}
          </div>
        </div>
        <div className={styles.turnSeal}>
          <small>{challenge?.phase === 'BLOCK' ? 'ENEMY TURN' : 'YOUR TURN'}</small>
          <strong>{challenge?.phase === 'BLOCK' ? '格挡！' : '出招！'}</strong>
        </div>
        <div className={styles.enemyPane}>
          <div className={styles.combatName}>
            <span>{currentRoom?.enemyName}</span>
            <strong>
              HP {currentRoom?.enemyHp}/{currentRoom?.enemyMaxHp}
            </strong>
          </div>
          <i className={styles.hp}>
            <b
              style={{
                width: `${((currentRoom?.enemyHp ?? 0) / Math.max(1, currentRoom?.enemyMaxHp ?? 1)) * 100}%`,
              }}
            />
          </i>
          <Monster type={currentRoom?.type ?? 'COMBAT'} />
          <p>
            {challenge?.phase === 'BLOCK'
              ? '敌人正在蓄力。答对可降低伤害。'
              : '它害怕被准确召回的英语。'}
          </p>
        </div>
        <AnimatePresence>
          {ui.fx && (
            <motion.div
              key={ui.fx.key}
              initial={{ opacity: 0, scale: 0.4, y: 20 }}
              animate={{ opacity: 1, scale: 1.15, y: -20 }}
              exit={{ opacity: 0 }}
              className={`${styles.damageFx} ${ui.fx.grade === 'MISS' ? styles.miss : ''}`}
            >
              {ui.fx.damage
                ? `-${ui.fx.damage}`
                : ui.fx.received
                  ? `HP -${ui.fx.received}`
                  : ui.fx.grade}
            </motion.div>
          )}
        </AnimatePresence>
      </section>
      <AnimatePresence>{ui.loot && <LootDrop item={ui.loot} />}</AnimatePresence>
      {run.loot.length > 0 && !ui.loot && (
        <div className={styles.lootSatchel}>
          <Backpack />
          <span>
            <small>本次战利品</small>
            <strong>{run.loot.length} 件 · 第一件已保险</strong>
          </span>
        </div>
      )}
      <form className={styles.challengeCard} onSubmit={submit}>
        <header>
          <span>
            {challenge?.phase === 'BLOCK' ? <Shield /> : <Swords />}
            {challengeTypeLabel(challenge?.type)}
          </span>
          <small>{challenge?.hint}</small>
        </header>
        <h1>{challenge?.prompt}</h1>
        {challenge && (
          <ChallengeInput
            challenge={challenge}
            answer={ui.answer}
            onAnswer={(value) => dispatch({ type: 'answer', value })}
          />
        )}
        {challenge?.phase === 'ATTACK' && (
          <SkillBar
            skills={run.availableSkills}
            resource={run.resource}
            selected={ui.selectedSkill}
            onSelect={(value) => dispatch({ type: 'skill', value })}
          />
        )}{' '}
        {error && <p className={styles.error}>{error}</p>}
        {ui.feedback && (
          <p className={ui.feedback.correct ? styles.success : styles.error}>
            上一回合：{ui.feedback.message}
            {ui.feedback.answer && !ui.feedback.correct ? ` 参考：${ui.feedback.answer}` : ''}
          </p>
        )}
        <button className={styles.strike} disabled={ui.busy || !ui.answer.length}>
          {ui.busy ? (
            <>
              <LoaderCircle className={styles.spin} /> 正在判定
            </>
          ) : challenge?.phase === 'BLOCK' ? (
            <>
              <Shield /> 格挡攻击
            </>
          ) : (
            <>
              <Swords /> 发动攻击
            </>
          )}
        </button>
      </form>
      {run.canRetreat && (
        <button
          className={styles.retreat}
          onClick={async () => {
            try {
              const next = await request<DungeonRunState>(
                `/adventure/runs/${run.id}/retreat`,
                { method: 'POST' },
                session.accessToken,
              );
              onRun(next);
            } catch (reason) {
              setError(userFacingError(reason));
            }
          }}
        >
          <TentTree /> 在营地安全撤退并带走战利品
        </button>
      )}
    </main>
  );
}

function ChallengeInput({
  challenge,
  answer,
  onAnswer,
}: {
  challenge: NonNullable<DungeonRunState['challenge']>;
  answer: string[];
  onAnswer: (value: string[]) => void;
}) {
  if (challenge.options)
    return (
      <div className={styles.options}>
        {challenge.options.map((option) => (
          <button
            type="button"
            className={answer[0] === option ? styles.selected : ''}
            key={option}
            onClick={() => onAnswer([option])}
          >
            {option}
          </button>
        ))}
      </div>
    );
  if (challenge.tokens)
    return (
      <div className={styles.order}>
        <div>
          {answer.map((token, index) => (
            <button
              type="button"
              key={`${token}-${index}`}
              onClick={() => onAnswer(answer.filter((_, position) => position !== index))}
            >
              {token}
            </button>
          ))}
        </div>
        <hr />
        <div>
          {challenge.tokens.map((token, index) => (
            <button
              type="button"
              disabled={
                answer.filter((item) => item === token).length >=
                challenge.tokens!.filter((item) => item === token).length
              }
              key={`${token}-${index}`}
              onClick={() => onAnswer([...answer, token])}
            >
              {token}
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <input
      autoFocus
      value={answer[0] ?? ''}
      placeholder={challenge.inputPlaceholder}
      onChange={(event) => onAnswer(event.target.value ? [event.target.value] : [])}
    />
  );
}

function SkillBar({
  skills,
  resource,
  selected,
  onSelect,
}: {
  skills: AdventureSkill[];
  resource: number;
  selected: string | null;
  onSelect: (value: string | null) => void;
}) {
  return (
    <div className={styles.skillBar}>
      <button
        type="button"
        className={!selected ? styles.selected : ''}
        onClick={() => onSelect(null)}
      >
        <Swords />
        <span>
          <strong>普通攻击</strong>
          <small>不消耗专注</small>
        </span>
      </button>
      {skills.slice(0, 4).map((skill) => (
        <button
          type="button"
          disabled={skill.cost > resource}
          className={selected === skill.id ? styles.selected : ''}
          key={skill.id}
          onClick={() => onSelect(skill.id)}
        >
          <Sparkles />
          <span>
            <strong>{skill.name.split('·')[1]}</strong>
            <small>{skill.cost} 点专注</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function Monster({ type }: { type: string }) {
  return (
    <motion.div
      className={styles.monster}
      animate={{ y: [0, -7, 0], rotate: [-1, 1, -1] }}
      transition={{ repeat: Infinity, duration: 2.4 }}
    >
      <i className={type === 'BOSS' ? styles.bossMonster : ''}>
        <span />
        <span />
        <b />
      </i>
      <em>{type === 'BOSS' ? 'BOSS' : 'VOCABULARY BEAST'}</em>
    </motion.div>
  );
}
function LootDrop({ item }: { item: InventoryItem }) {
  return (
    <motion.aside
      className={styles.lootDrop}
      initial={{ opacity: 0, y: 24, rotate: -2 }}
      animate={{ opacity: 1, y: 0, rotate: 0 }}
      exit={{ opacity: 0 }}
    >
      <i>{equipmentIcon(item.slot)}</i>
      <span>
        <small>{item.rarity} DROP</small>
        <strong>获得 {item.name}</strong>
        <em>{item.secured ? '首件战利品已自动保险' : '未保险 · 战败会遗失'}</em>
      </span>
      <Sparkles />
    </motion.aside>
  );
}
function RunResult({ run, onDone }: { run: DungeonRunState; onDone: () => void }) {
  const success = run.status === 'COMPLETED' || run.status === 'RETREATED';
  return (
    <main className={styles.resultPage}>
      <motion.div initial={{ scale: 0.8, rotate: -2 }} animate={{ scale: 1, rotate: 0 }}>
        <span>{success ? <Trophy /> : <Heart />}</span>
        <small>EXPEDITION {run.status}</small>
        <h1>
          {run.status === 'COMPLETED'
            ? '探索完成！'
            : run.status === 'RETREATED'
              ? '安全带回了战利品'
              : '这次倒在了地牢里'}
        </h1>
        <p>
          {success
            ? '学习证据与战利品已经写入冒险手账。'
            : '学习证据和探索度仍会保留；经验保留 30%，金币与材料带回一半。'}
        </p>
        <section>
          <b>+{run.experienceEarned} EXP</b>
          <b>+{run.goldEarned} 金币</b>
          <b>+{run.materialsEarned} 材料</b>
        </section>
        {run.loot.length > 0 && (
          <div className={styles.resultLoot}>
            <h2>带回的装备</h2>
            {run.loot.map((item) => (
              <article key={item.id}>
                <i>{equipmentIcon(item.slot)}</i>
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {rarityLabel(item.rarity)} · {item.secured ? '已保险' : '已带回'}
                  </small>
                </span>
              </article>
            ))}
          </div>
        )}
        <button onClick={onDone}>返回地牢地图</button>
      </motion.div>
    </main>
  );
}

function CharacterSheet({
  profile,
  busy,
  onAdvance,
  onUnlock,
}: {
  profile: AdventureProfile;
  busy: boolean;
  onAdvance: (key: string) => void;
  onUnlock: (id: string) => void;
}) {
  const choices = profile.availableClasses.filter((item) => item.available && !item.current);
  return (
    <section className={styles.sheet}>
      <header>
        <div>
          <small>CHARACTER & SKILL TREE</small>
          <h2>
            {profile.currentClass?.name} · Lv.{profile.level}
          </h2>
        </div>
        <span>{profile.skillPoints} 个技能点</span>
      </header>
      {choices.length > 0 && (
        <div className={styles.advancement}>
          <h3>转职道路已经出现</h3>
          {choices.map((item) => (
            <button disabled={busy} key={item.id} onClick={() => onAdvance(item.key)}>
              <strong>{item.name}</strong>
              <small>{item.description}</small>
              <ChevronRight />
            </button>
          ))}
        </div>
      )}
      <div className={styles.skillTree}>
        {profile.skills.map((skill, index) => (
          <article className={skill.unlocked ? styles.unlocked : ''} key={skill.id}>
            <i>{index + 1}</i>
            <div>
              <strong>{skill.name}</strong>
              <p>{skill.description}</p>
              <small>
                Lv.{skill.requiredLevel} · 消耗 {skill.cost}
              </small>
            </div>
            <button
              disabled={
                skill.unlocked ||
                profile.level < skill.requiredLevel ||
                profile.skillPoints < 1 ||
                busy
              }
              onClick={() => onUnlock(skill.id)}
            >
              {skill.unlocked ? '已掌握' : '学习'}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
function InventorySheet({
  inventory,
  onEquip,
}: {
  inventory: Inventory | null;
  onEquip: (id: string) => void;
}) {
  const slots: EquipmentSlot[] = ['WEAPON', 'ARMOR', 'ACCESSORY'];
  return (
    <section className={styles.sheet}>
      <header>
        <div>
          <small>FIELD INVENTORY</small>
          <h2>背包与装备</h2>
        </div>
        <span>{inventory?.items.length ?? 0} 件物品</span>
      </header>
      <section className={styles.equipmentRack}>
        <div className={styles.sectionTitle}>
          <small>EQUIPMENT SLOTS</small>
          <h3>当前装备栏</h3>
        </div>
        <div>
          {slots.map((slot) => {
            const item = inventory?.equipped[slot];
            return (
              <article key={slot} className={item ? styles.occupied : ''}>
                <i>{equipmentIcon(slot)}</i>
                <span>
                  <small>{slotLabel(slot)}</small>
                  <strong>{item?.name ?? '空槽位'}</strong>
                  <em>
                    {item
                      ? `${rarityLabel(item.rarity)} · 耐久 ${item.durability}%`
                      : '从背包中选择装备'}
                  </em>
                </span>
              </article>
            );
          })}
        </div>
      </section>
      <section className={styles.backpackSection}>
        <div className={styles.sectionTitle}>
          <small>TRAVEL PACK</small>
          <h3>旅行背包</h3>
          <span>精英、宝箱和首领会掉落装备</span>
        </div>
        {!inventory?.items.length ? (
          <div className={styles.packEmpty}>
            <Backpack />
            <div>
              <strong>背包还是空的</strong>
              <p>击败第一个精英就会获得装备；本局第一件掉落自动保险。</p>
            </div>
          </div>
        ) : (
          <div className={styles.inventory}>
            {inventory.items.map((item) => (
              <article key={item.id}>
                <span className={`${styles.rarity} ${styles[item.rarity.toLowerCase()]}`}>
                  {rarityLabel(item.rarity)}
                </span>
                <i>{equipmentIcon(item.slot)}</i>
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.description}</p>
                  <small>
                    耐久 {item.durability}% ·{' '}
                    {Object.entries(item.stats)
                      .map(
                        ([key, value]) =>
                          `${statLabel(key)} +${Math.round(value * (key.includes('Multiplier') ? 100 : 1))}`,
                      )
                      .join(' / ')}
                  </small>
                  {item.secured && <em className={styles.insured}>已保险</em>}
                </div>
                <button disabled={item.equipped} onClick={() => onEquip(item.id)}>
                  {item.equipped ? '已装备' : '装备'}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
function AdventureLoading({ onBack, message }: { onBack: () => void; message?: string }) {
  return (
    <main className={styles.loading}>
      <button onClick={onBack}>
        <ArrowLeft />
      </button>
      <LoaderCircle className={styles.spin} />
      <strong>{message || '正在绘制地牢地图…'}</strong>
    </main>
  );
}
function challengeTypeLabel(type?: string) {
  return (
    (
      {
        CHOICE: '识别',
        SPELLING: '拼写',
        SENTENCE_ORDER: '组句',
        MATCHING: '搭配',
        FREE_RESPONSE: '自由表达',
      } as Record<string, string>
    )[type ?? ''] ?? '挑战'
  );
}
function statLabel(key: string) {
  return (
    (
      {
        attackMultiplier: '攻击',
        blockBonus: '格挡',
        maxHp: '生命',
        materialBonus: '材料',
        goldBonus: '金币',
        productionExperience: '表达经验',
      } as Record<string, string>
    )[key] ?? key
  );
}
function equipmentIcon(slot: EquipmentSlot) {
  return slot === 'WEAPON' ? <Swords /> : slot === 'ARMOR' ? <Shield /> : <Gem />;
}
function slotLabel(slot: EquipmentSlot) {
  return ({ WEAPON: '武器', ARMOR: '护甲', ACCESSORY: '饰品' } as const)[slot];
}
function rarityLabel(rarity: InventoryItem['rarity']) {
  return ({ COMMON: '普通', RARE: '稀有', EPIC: '史诗', LEGENDARY: '传说' } as const)[rarity];
}
