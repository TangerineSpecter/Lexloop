import { describe, expect, it } from 'vitest';
import { storyByKey } from '../src/modules/micro-stories/micro-stories.catalog';

describe('micro-story English learning content', () => {
  it('keeps the bike-repair misunderstanding, confirmation and resolution unambiguous', () => {
    const first = storyByKey('bike-repair-01');
    const second = storyByKey('bike-repair-02');
    const third = storyByKey('bike-repair-03');

    expect([first, second, third].map((story) => story?.key)).toEqual([
      'bike-repair-01',
      'bike-repair-02',
      'bike-repair-03',
    ]);
    expect(
      [first, second, third].every(
        (story, index) =>
          story?.series === '单车维修' && story.level === 'B1' && story.part === index + 1,
      ),
    ).toBe(true);

    expect(first?.english).toContain('ready after 4 p.m.');
    expect(first?.english).toContain('collect it before 4');
    expect(first?.reference).toContain('4 点以后可以取车');
    expect(first?.reference).toContain('4 点前就能取');
    expect(first?.explanation).toContain('不是 4 点之前');

    expect(second?.english).toContain('will not be ready before 4');
    expect(second?.english).toContain('around 4:30');
    expect(second?.reference).toContain('4 点前还不能取');
    expect(second?.reference).toContain('预计 4 点半左右');
    expect(second?.explanation).toContain('不是保证精确到 4 点半');

    expect(third?.english).toContain('At 4:30');
    expect(third?.english).toContain('meet her outside the shop at 4:45');
    expect(third?.english).toContain('collects the bike');
    expect(third?.reference).toContain('4 点 45 分在店外见面');
    expect(third?.reference).toContain('取回自行车后');
  });

  it('teaches that by Friday includes Friday as the latest deadline', () => {
    const story = storyByKey('deadline-03');

    expect(story).toBeDefined();
    expect(story?.reference).toContain('最迟在周五完成');
    expect(story?.explanation).toContain('周五当天也在期限内');
    expect(story?.focusMeaning).toContain('周五或更早完成');
  });
});
