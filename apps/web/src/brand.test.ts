import { describe, expect, it } from 'vitest';
import {
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
  PRODUCT_REPOSITORY_URL,
  PRODUCT_TAGLINE,
  PRODUCT_TAGLINE_SENTENCE,
} from './brand';

describe('product brand contract', () => {
  it('keeps every user-visible brand value aligned', () => {
    expect({
      name: PRODUCT_NAME,
      tagline: PRODUCT_TAGLINE,
      sentenceTagline: PRODUCT_TAGLINE_SENTENCE,
      description: PRODUCT_DESCRIPTION,
      repository: PRODUCT_REPOSITORY_URL,
    }).toEqual({
      name: 'Shepherd',
      tagline: 'Shepherd Your Agents',
      sentenceTagline: 'Shepherd your agents',
      description: 'Manage nodes, projects, and CLI coding agents from one web paddock.',
      repository: 'https://github.com/billiondollarsolo/shepherd',
    });
  });
});
