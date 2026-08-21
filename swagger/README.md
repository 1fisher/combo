# swagger

vendored from rune repo at commit `28ed89ffd6115fdc8439c68bb65d6f40b11d7725`:

- `swagger.json` — 原始 Swagger 2.0 文件(上游未经修改,可追溯)
- `swagger.openapi3.json` — 经 `swagger2openapi` 转换的 OpenAPI 3.0 文件
  (52 paths / 59 schemas / 0 warnings;`basePath: /v1` 迁移为 `servers: [{url: "/v1"}]`)

`npm run gen:api` 使用 `swagger.openapi3.json` 生成 `src/lib/api/types.ts`:
openapi-typescript 7.x 不再支持 Swagger 2.0,且 7.x 移除了对 undici 的
依赖(修复 Dependabot 漏洞)。如需重新同步上游,更新 `swagger.json` 后重跑:

```bash
npx swagger2openapi swagger/swagger.json -o swagger/swagger.openapi3.json
npm run gen:api
```
