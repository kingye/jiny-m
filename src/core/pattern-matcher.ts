import type { Pattern, PatternMatch } from '../types';
import { extractDomain, validateRegex, stripReplyPrefix } from '../utils/helpers';

export class PatternMatcher {
  private patterns: Pattern[];
  
  constructor(patterns: Pattern[]) {
    this.patterns = patterns.filter(p => p.enabled !== false);
  }
  
  match(sender: string, subject: string): PatternMatch | null {
    for (const pattern of this.patterns) {
      const match = this.matchPattern(sender, subject, pattern);
      if (match) {
        return match;
      }
    }
    return null;
  }
  
  private matchPattern(sender: string, subject: string, pattern: Pattern): PatternMatch | null {
    const matches: PatternMatch['matches'] = {};
    
    const senderMatch = this.matchSender(sender, pattern.sender, pattern.caseSensitive);
    if (senderMatch) {
      matches.sender = senderMatch;
    }
    
    const subjectMatch = this.matchSubject(subject, pattern.subject, pattern.caseSensitive);
    if (subjectMatch) {
      matches.subject = subjectMatch;
    }
    
    const hasSenderMatch = !!pattern.sender;
    const hasSubjectMatch = !!pattern.subject;
    
    const senderConditionMet = pattern.sender ? !!senderMatch : true;
    const subjectConditionMet = pattern.subject ? !!subjectMatch : true;
    
    if (senderConditionMet && subjectConditionMet) {
      return {
        patternName: pattern.name,
        matches,
      };
    }
    
    return null;
  }
  
  private matchSender(sender: string, senderPattern: Pattern['sender'], caseSensitive: boolean = false): PatternMatch['matches']['sender'] | null {
    if (!senderPattern) return null;
    
    const normalizedSender = caseSensitive ? sender : sender.toLowerCase();
    
    if (senderPattern.regex) {
      if (validateRegex(senderPattern.regex)) {
        const regex = caseSensitive 
          ? new RegExp(senderPattern.regex) 
          : new RegExp(senderPattern.regex, 'i');
        
        if (regex.test(normalizedSender)) {
          return { type: 'regex', value: senderPattern.regex };
        }
      }
    }
    
    if (senderPattern.exact && senderPattern.exact.length > 0) {
      for (const exact of senderPattern.exact) {
        const normalizedExact = caseSensitive ? exact : exact.toLowerCase();
        if (normalizedSender === normalizedExact) {
          return { type: 'exact', value: exact };
        }
      }
    }
    
    if (senderPattern.domain && senderPattern.domain.length > 0) {
      const domain = extractDomain(sender);
      if (domain) {
        const normalizedDomain = caseSensitive ? domain : domain.toLowerCase();
        for (const patternDomain of senderPattern.domain) {
          const normalizedPatternDomain = caseSensitive ? patternDomain : patternDomain.toLowerCase();
          if (normalizedDomain === normalizedPatternDomain) {
            return { type: 'domain', value: patternDomain };
          }
        }
      }
    }
    
    return null;
  }
  
  private matchSubject(subject: string, subjectPattern: Pattern['subject'], caseSensitive: boolean = false): PatternMatch['matches']['subject'] | null {
    if (!subjectPattern) return null;

    // Strip reply/forward prefixes (Re:, Fwd:, etc.)
    const strippedSubject = stripReplyPrefix(subject);
    const normalizedSubject = caseSensitive ? strippedSubject : strippedSubject.toLowerCase();

    const prefix = subjectPattern.prefix;
    const regex = subjectPattern.regex;

    // No rules defined
    if (!prefix && !regex) {
      return null;
    }

    // Check prefix (OR within the array)
    let prefixMatched = false;
    if (prefix && prefix.length > 0) {
      for (const pref of prefix) {
        const normalizedPrefix = caseSensitive ? pref : pref.toLowerCase();
        if (normalizedSubject.startsWith(normalizedPrefix)) {
          prefixMatched = true;
          break;
        }
      }
    }

    // Check regex (optional additional rule)
    let regexMatched = false;
    if (regex && validateRegex(regex)) {
      const regexPattern = caseSensitive 
        ? new RegExp(regex) 
        : new RegExp(regex, 'i');
      
      // Apply regex to the original subject (before stripping prefixes)
      const normalizedOriginalSubject = caseSensitive ? subject : subject.toLowerCase();
      regexMatched = regexPattern.test(normalizedOriginalSubject);
    }

    // AND logic:
    // - If both prefix and regex exist, both must match
    // - If only prefix exists, it must match
    // - If only regex exists, it must match
    const needsPrefix = prefix && prefix.length > 0;
    const needsRegex = !!regex;

    if (needsPrefix && needsRegex) {
      if (!prefixMatched || !regexMatched) {
        return null;
      }
    } else if (needsPrefix) {
      if (!prefixMatched) {
        return null;
      }
    } else if (needsRegex) {
      if (!regexMatched) {
        return null;
      }
    }

    // Return match info
    const matches: any = {};

    if (prefixMatched) {
      // Find which prefix pattern matched
      const matchedPrefix = prefix?.find((pref: string) => {
        const normalizedPrefix = caseSensitive ? pref : pref.toLowerCase();
        return normalizedSubject.startsWith(normalizedPrefix);
      });
      if (matchedPrefix) {
        matches.prefix = matchedPrefix;
      }
    }

    if (regexMatched) {
      matches.regex = regex;
    }

    return matches;
  }
  
  getPatternsCount(): number {
    return this.patterns.length;
  }
  
  getPatterns(): Pattern[] {
    return [...this.patterns];
  }
}

export function createPatternMatcher(patterns: Pattern[]): PatternMatcher {
  return new PatternMatcher(patterns);
}