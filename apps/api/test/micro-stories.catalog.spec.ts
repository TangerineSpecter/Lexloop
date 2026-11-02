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

  it('keeps the grocery restocking arc factually ordered and its target phrases contextual', () => {
    const first = storyByKey('grocery-01');
    const second = storyByKey('grocery-02');
    const third = storyByKey('grocery-03');

    expect([first, second, third].map((story) => story?.key)).toEqual([
      'grocery-01',
      'grocery-02',
      'grocery-03',
    ]);
    expect(
      [first, second, third].every(
        (story, index) =>
          story?.series === '超市补货' && story.level === 'B1' && story.part === index + 1,
      ),
    ).toBe(true);

    expect(first?.english).toContain('has run out of rice');
    expect(first?.reference).toContain('米已经吃完');
    expect(first?.explanation).toContain('已经用完');
    expect(second?.english).toContain('shelf is empty');
    expect(second?.english).toContain('checks, finds none');
    expect(second?.english).toContain('next delivery is due tomorrow');
    expect(second?.reference).toContain('预计明天到');
    expect(second?.explanation).toContain('不表示已经到店');
    expect(third?.english).toContain('does not want to wait');
    expect(third?.english).toContain('after the delivery arrives');
    expect(third?.reference).toContain('今晚换一道晚餐');
    expect(third?.reference).toContain('新货到了');
  });

  it('keeps the library renewal, hold and return arc consistent about each book', () => {
    const first = storyByKey('library-return-01');
    const second = storyByKey('library-return-02');
    const third = storyByKey('library-return-03');

    expect([first, second, third].map((story) => story?.key)).toEqual([
      'library-return-01',
      'library-return-02',
      'library-return-03',
    ]);
    expect(
      [first, second, third].every(
        (story, index) =>
          story?.series === '归还图书' && story.level === 'B1' && story.part === index + 1,
      ),
    ).toBe(true);

    expect(first?.english).toContain('two library books due on Monday');
    expect(first?.english).toContain('renew one of the books');
    expect(first?.reference).toContain('其中一本');
    expect(second?.english).toContain('cannot');
    expect(second?.english).toContain('another reader has placed a hold on it');
    expect(second?.english).toContain('must be returned by Monday');
    expect(second?.reference).toContain('所以不能续借');
    expect(second?.reference).toContain('最迟要在周一归还');
    expect(third?.english).toContain('due date has been extended by a week');
    expect(third?.english).toContain('Evan returns the reserved book at the front desk');
    expect(third?.reference).toContain('归还了被预约的那本书');
    expect(third?.reference).toContain('并留下第一本');
  });
});
