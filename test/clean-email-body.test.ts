import { test, expect, describe } from 'bun:test';
import { cleanEmailBody } from '../src/core/email-parser';

describe('cleanEmailBody', () => {
  describe('bracket-nested email addresses', () => {
    test('should clean simple single-line bracket nesting', () => {
      const input = 'KINGYE@PETALMAIL.COM [kingye@petalmail.com] (06:03 PM)';
      const result = cleanEmailBody(input);
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');
      expect(result).toContain('KINGYE@PETALMAIL.COM');
      expect(result).toContain('(06:03 PM)');
    });

    test('should clean multi-line bracket nesting (2 levels)', () => {
      const input = `KINGYE@PETALMAIL.COM [kingye@petalmail.com
[kingye@petalmail.com]] (05:48 PM)`;
      const result = cleanEmailBody(input);
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');
      expect(result).toContain('KINGYE@PETALMAIL.COM');
      expect(result).toContain('(05:48 PM)');
    });

    test('should clean deeply nested multi-line brackets (3+ levels)', () => {
      const input = `KINGYE@PETALMAIL.COM [KINGYE@PETALMAIL.COM
[KINGYE@PETALMAIL.COM]] [kingye@petalmail.com
[kingye@petalmail.com]] (05:28 PM)`;
      const result = cleanEmailBody(input);
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');
      expect(result).toContain('KINGYE@PETALMAIL.COM');
      expect(result).toContain('(05:28 PM)');
    });

    test('should clean exponentially nested sender addresses', () => {
      const input = `KINGYE@PETALMAIL.COM [KINGYE@PETALMAIL.COM
[KINGYE@PETALMAIL.COM]] [KINGYE@PETALMAIL.COM
[KINGYE@PETALMAIL.COM [kingye@petalmail.com
[kingye@petalmail.com] [kingye@petalmail.com
[kingye@petalmail.com [kingye@petalmail.com
[kingye@petalmail.com]]]] (05:18 PM)`;
      const result = cleanEmailBody(input);
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');
      expect(result).toContain('KINGYE@PETALMAIL.COM');
      expect(result).toContain('(05:18 PM)');
    });

    test('should clean nested addresses in 发件人/收件人 lines', () => {
      const input = `发件人：jiny283@163.com [jiny283@163.com
[jiny283@163.com [jiny283@163.com]]]
发件时间：2026年3月20日星期五 17:19 收件人：kingye@petalmail.com
[kingye@petalmail.com [kingye@petalmail.com
[kingye@petalmail.com]]]`;
      const result = cleanEmailBody(input);
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');
      expect(result).toContain('发件人：jiny283@163.com');
      expect(result).toContain('收件人：kingye@petalmail.com');
    });

    test('should clean deeply nested 发件人 with 4+ levels', () => {
      const input = `发件人：jiny283@163.com [jiny283@163.com
[jiny283@163.com]] [jiny283@163.com [jiny283@163.com
[jiny283@163.com]]] [jiny283@163.com [jiny283@163.com
[jiny283@163.com]] [jiny283@163.com [jiny283@163.com
[jiny283@163.com]]]] 发件时间：2026年3月20日星期五 16:15`;
      const result = cleanEmailBody(input);
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');
      expect(result).toContain('发件人：jiny283@163.com');
      expect(result).toContain('发件时间：2026年3月20日星期五 16:15');
    });

    test('should clean inside quoted lines (> prefix)', () => {
      const input = `> > 发件人：jiny283@163.com [jiny283@163.com
> > 发件时间：2026年3月20日 收件人：kingye@petalmail.com
> > [kingye@petalmail.com 主题：Re: 回复: Re: Jiny: test`;
      const result = cleanEmailBody(input);
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');
      expect(result).toContain('发件人：jiny283@163.com');
      expect(result).toContain('收件人：kingye@petalmail.com');
    });
  });

  describe('URL bracket nesting', () => {
    test('should clean URL-encoded bracket nesting', () => {
      const input = ` 1. 访问 https://open.feishu.cn/
    [https://open.feishu.cn/] [https://open.feishu.cn/%5D]
    [https://open.feishu.cn/] [https://open.feishu.cn/%5D]
    [https://open.feishu.cn/%5D] [https://open.feishu.cn/%5D%5D]`;
      const result = cleanEmailBody(input);
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');
      expect(result).not.toContain('%5D');
      expect(result).toContain('https://open.feishu.cn/');
      expect(result).toContain('1. 访问');
    });

    test('should clean deeply nested URL brackets (8+ levels)', () => {
      const input = ` 1. 访问 https://open.feishu.cn/
    [https://open.feishu.cn/] [https://open.feishu.cn/%5D]
    [https://open.feishu.cn/] [https://open.feishu.cn/%5D]
    [https://open.feishu.cn/%5D] [https://open.feishu.cn/%5D%5D]
    [https://open.feishu.cn/] [https://open.feishu.cn/%5D]
    [https://open.feishu.cn/%5D] [https://open.feishu.cn/%5D%5D]
    [https://open.feishu.cn/%5D] [https://open.feishu.cn/%5D%5D]
    [https://open.feishu.cn/%5D%5D] [https://open.feishu.cn/%5D%5D%5D]`;
      const result = cleanEmailBody(input);
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');
      expect(result).not.toContain('%5D');
      expect(result).toContain('https://open.feishu.cn/');
    });
  });

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
  });

  describe('preserves normal content', () => {
    test('should not modify plain text content', () => {
      const input = '飞书机器人注册需要在网页端操作，手机应用上不能完成注册：';
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

    test('should preserve quoted text prefixes', () => {
      const input = `> 已更换调色方案，采用Teal青色调设计，更具现代感。
> > 更换调色方案。
> > > 好的。将我们的讨论总结一下`;
      const result = cleanEmailBody(input);
      expect(result).toContain('> 已更换调色方案');
      expect(result).toContain('> > 更换调色方案');
      expect(result).toContain('> > > 好的');
    });

    test('should preserve dividers', () => {
      const input = '--------------------------------------------------------------------------------';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });

    test('should preserve URLs without brackets', () => {
      const input = '访问 https://open.feishu.cn/ 进行注册';
      const result = cleanEmailBody(input);
      expect(result).toContain('https://open.feishu.cn/');
    });

    test('should preserve email addresses without brackets', () => {
      const input = '发件人：jiny283@163.com 发件时间：2026年3月20日';
      const result = cleanEmailBody(input);
      expect(result).toBe(input);
    });
  });

  describe('full real-world email body', () => {
    test('should clean a complete multi-level quoted email body', () => {
      const input = `把最近改的那个ppt版本发给我。
 


发件人：jiny283@163.com
发件时间：2026年3月20日星期五 18:05
收件人：kingye@petalmail.com
主题：Re: 
Jiny: 微信飞书钉钉以及其它协作工具
 



已用Python
python-pptx库重新生成PPT

--------------------------------------------------------------------------------


KINGYE@PETALMAIL.COM [kingye@petalmail.com] (06:03 PM)

> 为什么我用macos上的powerpoint打开这个ppt时，总是报错
> 
> 发件人：jiny283@163.com 发件时间：2026年3月20日星期五 17:51
> 收件人：kingye@petalmail.com 主题：Re: 回复: Re: 回复: Re: Jiny: 微信飞书钉钉以及其它协作工具  
> 
> 已更换调色方案
> 
> KINGYE@PETALMAIL.COM [kingye@petalmail.com
> [kingye@petalmail.com]] (05:48 PM)
> 
> > 发件人：jiny283@163.com [jiny283@163.com
> > 发件时间：2026年3月20日 收件人：kingye@petalmail.com
> > [kingye@petalmail.com 主题：Re: 回复: Re: 回复: Re: Jiny: 微信飞书钉钉以及其它协作工具`;

      const result = cleanEmailBody(input);

      // No brackets should remain
      expect(result).not.toContain('[');
      expect(result).not.toContain(']');

      // Original content preserved
      expect(result).toContain('把最近改的那个ppt版本发给我');
      expect(result).toContain('已用Python');
      expect(result).toContain('已更换调色方案');

      // Email addresses preserved but without brackets
      expect(result).toContain('jiny283@163.com');
      expect(result).toContain('kingye@petalmail.com');
      expect(result).toContain('KINGYE@PETALMAIL.COM');

      // Subject lines normalized
      expect(result).not.toMatch(/回复: Re: 回复:/);
    });
  });
});
