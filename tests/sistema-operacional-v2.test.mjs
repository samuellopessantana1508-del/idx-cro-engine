import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'sistema-operacional-v2', 'index.html'), 'utf8');

test('Sistema Operacional v2 mantém JavaScript válido', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .join('\n');
  const result = spawnSync(process.execPath, ['--check', '-'], {
    input: scripts,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});

test('Atividades por cliente e POPs padronizados estão disponíveis', () => {
  assert.match(html, /id: 'atividades', label: 'Atividades'/);
  assert.match(html, /function renderClientAtividades/);
  assert.match(html, /analise_diaria/);
  assert.match(html, /otimizacao_diaria/);
  assert.match(html, /revisao_semanal/);
  assert.match(html, /plano_mensal/);
  assert.match(html, /Complete os 7 critérios do POP/);
  assert.match(html, /Analisar[\s\S]*Diagnosticar[\s\S]*Otimizar[\s\S]*Documentar/);
});

test('Tema monocromático, dependência fixa e preview seguro', () => {
  assert.match(html, /--bg-absolute: #F4F4F2/);
  assert.match(html, /filter: grayscale\(1\)/);
  assert.match(html, /@supabase\/supabase-js@2\.112\.3/);
  assert.match(html, /\['127\.0\.0\.1', 'localhost'\]\.includes\(window\.location\.hostname\)/);
  assert.doesNotMatch(html, /service_role/i);
});
