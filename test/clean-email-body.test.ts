import { test, expect, describe } from 'bun:test';
import { cleanEmailBody } from '../src/core/email-parser';
import { marked } from 'marked';

// Import smtp module to trigger marked configuration (auto-link disabled)
import '../src/services/smtp/index';

describe('cleanEmailBody', () => {
  describe('subject line cleanup', () => {
    test('should normalize redundant Re: in 主题 lines', () => {
      const input = '主题：Re: 回复: Re: 回复: Re: 回复: Re: Jiny: 微信飞书钉钉以及其它协作工具';
      const result = cleanEmailBody(input);
      expect(result).toBe('主题：Re: Jiny: 微信飞书钉钉以及其它协作工具');
    });

    test('should normalize Subject: lines in quoted blocks', () => {
      const input = '> > > 主题：Re: 回复: Re: 回复: Re: Jiny: test';
      const result = cleanEmailBody(input);
      expect(result).toBe('> > > 主题：Re: Jiny: test');
    });

    test('should normalize mid-line 主题', () => {
      const input = '> 收件人：kingye@petalmail.com 主题：Re: 回复: Re: 回复: Re: Jiny: test';
      const result = cleanEmailBody(input);
      expect(result).toContain('主题：Re: Jiny: test');
      expect(result).not.toMatch(/回复: Re: 回复:/);
    });
  });

  describe('preserves all content', () => {
    test('should not modify plain text content', () => {
      const input = '飞书机器人注册需要在网页端操作，手机应用上不能完成注册：';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });

    test('should preserve brackets with text content', () => {
      const input = 'This is [a note] in brackets';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });

    test('should preserve nested brackets with text content', () => {
      const input = 'Nested: [[[it is a text]]]';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });

    test('should preserve array syntax', () => {
      const input = 'Array syntax: arr[0] = value';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });

    test('should preserve references like [1] [2]', () => {
      const input = 'Reference [1] and [2]';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });

    test('should preserve JSON with arrays', () => {
      const input = 'JSON example: {"key": ["value1", "value2"]}';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });

    test('should preserve email addresses with brackets from email clients', () => {
      // These brackets are now left as-is — the root cause (auto-linking) is fixed
      const input = 'jiny283@163.com [jiny283@163.com]';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });

    test('should preserve URLs', () => {
      const input = '访问 https://open.feishu.cn/ 进行注册';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });

    test('should preserve numbered lists', () => {
      const input = ` 1. 需求分析
 2. 工具对比（飞书/钉钉/微信）
 3. 飞书API核心功能`;
      const result = cleanEmailBody(input);
      expect(result).toContain('1. 需求分析');
      expect(result).toContain('2. 工具对比');
      expect(result).toContain('3. 飞书API核心功能');
    });

    test('should preserve dividers', () => {
      const input = '--------------------------------------------------------------------------------';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });
  });
});

describe('marked auto-linking disabled', () => {
  test('should not auto-link email addresses', () => {
    const html = marked.parse('发件人：jiny283@163.com 发件时间：2026年3月20日', { async: false }) as string;
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('mailto:');
    expect(html).toContain('jiny283@163.com');
  });

  test('should not auto-link bare URLs in text', () => {
    const html = marked.parse('访问 https://open.feishu.cn/ 进行注册', { async: false }) as string;
    expect(html).not.toContain('<a ');
    expect(html).toContain('https://open.feishu.cn/');
  });

  test('should not auto-link email addresses in quoted blocks', () => {
    const html = marked.parse('> KINGYE@PETALMAIL.COM (06:03 PM)', { async: false }) as string;
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('mailto:');
    expect(html).toContain('KINGYE@PETALMAIL.COM');
  });

  test('should not auto-link email in heading', () => {
    const html = marked.parse('### KINGYE@PETALMAIL.COM (06:03 PM)', { async: false }) as string;
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('mailto:');
    expect(html).toContain('KINGYE@PETALMAIL.COM');
  });

  test('should simulate a full reply and have no auto-linked addresses', () => {
    const replyMarkdown = `已修改PPT，把标题从蓝底白字改为白底黑字，请查收。

---
### kingye@petalmail.com (10:25 PM)
> Jiny: 微信飞书钉钉以及其它协作工具

> 你可不可以在sap模板的基础上创建PPT？

> 发件人：jiny283@163.com 发件时间：2026年3月20日
> 收件人：kingye@petalmail.com
> 主题：Re: Jiny: 微信飞书钉钉以及其它协作工具

> 这是按照SAP模板制作的PPT。

> 访问 https://open.feishu.cn/ 进行注册`;

    const html = marked.parse(replyMarkdown, { async: false }) as string;

    // No auto-linked email addresses
    expect(html).not.toContain('mailto:');

    // All addresses and URLs preserved as plain text (not in <a> tags)
    expect(html).toContain('kingye@petalmail.com');
    expect(html).toContain('jiny283@163.com');
    expect(html).toContain('https://open.feishu.cn/');

    // Count <a> tags — should be zero (no auto-linking)
    const linkCount = (html.match(/<a /g) || []).length;
    expect(linkCount).toBe(0);
  });
});
