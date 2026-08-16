import { describe, expect, it } from 'vitest';
import { langDisplayName, langFromPath, langFromShebang } from './codeLang';

describe('langFromPath', () => {
  it.each([
    ['src/main.rs', 'rust'],
    ['a.py', 'python'],
    ['x/go/file.go', 'go'],
    ['App.tsx', 'typescript'],
    ['index.jsx', 'javascript'],
    ['lib/util.ts', 'typescript'],
    ['Main.java', 'java'],
    ['a.cpp', 'cpp'],
    ['styles.scss', 'scss'],
    ['config.yml', 'yaml'],
    ['Cargo.toml', 'ini'],
    ['README.md', 'markdown'],
    ['Makefile', 'makefile'],
    ['Dockerfile', 'dockerfile'],
    ['.gitignore', 'ini'],
    ['dir\\win\\path.ps1', 'powershell'],
    ['script.dart', 'dart'],
  ])('%s → %s', (path, lang) => {
    expect(langFromPath(path)).toBe(lang);
  });

  it('未知扩展名或无扩展名返回 null', () => {
    expect(langFromPath('data.xyz')).toBeNull();
    expect(langFromPath('justfile')).toBeNull();
    expect(langFromPath('')).toBeNull();
    expect(langFromPath('dir/')).toBeNull();
  });
});

describe('langFromShebang', () => {
  it.each([
    ['#!/usr/bin/env python3\nprint(1)', 'python'],
    ['#!/bin/bash\necho hi', 'bash'],
    ['#!/usr/bin/env node\nconsole.log(1)', 'javascript'],
    ['#!/usr/bin/ruby\nputs 1', 'ruby'],
  ])('识别 shebang 语言', (content, lang) => {
    expect(langFromShebang(content)).toBe(lang);
  });

  it('非 shebang 内容返回 null', () => {
    expect(langFromShebang('fn main() {}')).toBeNull();
    expect(langFromShebang('')).toBeNull();
  });
});

describe('langDisplayName', () => {
  it('映射常见语言的展示名,未映射的原样返回', () => {
    expect(langDisplayName('typescript')).toBe('TypeScript');
    expect(langDisplayName('cpp')).toBe('C++');
    expect(langDisplayName('unknownlang')).toBe('unknownlang');
  });
});
