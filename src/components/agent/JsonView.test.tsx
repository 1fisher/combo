import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JsonView, tryParseJson } from './JsonView';

describe('tryParseJson', () => {
  it('parses objects and arrays only', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('[1,2]')).toEqual([1, 2]);
    expect(tryParseJson('   {"a": 1}  ')).toEqual({ a: 1 });
  });

  it('returns null for non-JSON text', () => {
    expect(tryParseJson('plain text')).toBeNull();
    expect(tryParseJson('{invalid')).toBeNull();
    expect(tryParseJson('"string"')).toBeNull();
    expect(tryParseJson('')).toBeNull();
  });
});

describe('JsonView', () => {
  it('renders object keys and values', () => {
    render(<JsonView data={{ name: 'ls', count: 3 }} />);
    expect(screen.getByText('name')).toBeTruthy();
    expect(screen.getByText('ls')).toBeTruthy();
    expect(screen.getByText('count')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('renders arrays with indices', () => {
    render(<JsonView data={['a', 'b']} />);
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy();
  });

  it('renders nested objects', () => {
    render(<JsonView data={{ outer: { inner: true } }} />);
    expect(screen.getByText('outer')).toBeTruthy();
    expect(screen.getByText('inner')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
  });

  it('renders primitives (null / boolean / number)', () => {
    render(<JsonView data={null} />);
    expect(screen.getByText('null')).toBeTruthy();
    render(<JsonView data={false} />);
    expect(screen.getByText('false')).toBeTruthy();
    render(<JsonView data={3.14} />);
    expect(screen.getByText('3.14')).toBeTruthy();
  });
});
