import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePattern } from '../../config/schemas';
import { DEFAULT_CONFIG_PATH } from '../../utils/constants';

export async function listPatternsCommand(configPath?: string): Promise<void> {
  const filePath = configPath || DEFAULT_CONFIG_PATH;
  const fullPath = join(process.cwd(), filePath);
  
  try {
    const fileContent = await readFile(fullPath, 'utf-8');
    const config = JSON.parse(fileContent);
    
    const patterns = config.patterns || [];
    
    if (patterns.length === 0) {
      console.log('No patterns configured.');
      return;
    }
    
    console.log(`\nPatterns (${patterns.length}):\n`);
    
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      console.log(`${i + 1}. ${pattern.name}`);
      console.log(`   Status: ${pattern.enabled !== false ? 'Enabled' : 'Disabled'}`);
      console.log(`   Case sensitive: ${pattern.caseSensitive ? 'Yes' : 'No'}`);
      
      if (pattern.sender) {
        console.log(`   Sender:`);
        if (pattern.sender.exact) {
          console.log(`     Exact: ${pattern.sender.exact.join(', ')}`);
        }
        if (pattern.sender.domain) {
          console.log(`     Domains: ${pattern.sender.domain.join(', ')}`);
        }
        if (pattern.sender.regex) {
          console.log(`     Regex: ${pattern.sender.regex}`);
        }
      }
      
      if (pattern.subject) {
        console.log(`   Subject:`);
        if (pattern.subject.exact) {
          console.log(`     Exact: ${pattern.subject.exact.join(', ')}`);
        }
        if (pattern.subject.contains) {
          console.log(`     Contains: ${pattern.subject.contains.join(', ')}`);
        }
        if (pattern.subject.regex) {
          console.log(`     Regex: ${pattern.subject.regex}`);
        }
      }
      
      console.log('');
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to list patterns: ${errorMessage}`);
    process.exit(1);
  }
}

export async function addPatternCommand(patternData: any, configPath?: string): Promise<void> {
  const filePath = configPath || DEFAULT_CONFIG_PATH;
  const fullPath = join(process.cwd(), filePath);
  
  try {
    const fileContent = await readFile(fullPath, 'utf-8');
    const config = JSON.parse(fileContent);
    
    if (!config.patterns) {
      config.patterns = [];
    }
    
    const validatedPattern = validatePattern(patternData);
    
    const existingPatternNames = config.patterns.map((p: any) => p.name);
    if (existingPatternNames.includes(validatedPattern.name)) {
      console.error(`Pattern with name "${validatedPattern.name}" already exists.`);
      process.exit(1);
    }
    
    config.patterns.push(validatedPattern);
    
    await writeFile(fullPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`Pattern "${validatedPattern.name}" added successfully.`);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to add pattern: ${errorMessage}`);
    process.exit(1);
  }
}