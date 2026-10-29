import { describe, expect, it } from 'vitest';
import { storyByKey } from '../src/modules/micro-stories/micro-stories.catalog';

describe('micro-story English learning content', () => {
  it('teaches that by Friday includes Friday as the latest deadline', () => {
    const story = storyByKey('deadline-03');

    expect(story).toBeDefined();
    expect(story?.reference).toContain('最迟在周五完成');
    expect(story?.explanation).toContain('周五当天也在期限内');
    expect(story?.focusMeaning).toContain('周五或更早完成');
  });
});
