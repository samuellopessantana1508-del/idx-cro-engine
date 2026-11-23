import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const distDir = join(process.cwd(), "dist");
const indexPath = join(distDir, "index.html");
const fallbackPath = join(distDir, "404.html");

if (!existsSync(indexPath)) {
  throw new Error(`Build output not found: ${indexPath}`);
}

copyFileSync(indexPath, fallbackPath);
console.log("Created SPA fallback:", fallbackPath);

// Formulários públicos: croengine.pro/f/?<endereço>. O servidor só entrega arquivos que existem,
// então /f/ precisa de um index.html próprio (o mesmo do site; o main.tsx abre só o formulário).
mkdirSync(join(distDir, "f"), { recursive: true });
copyFileSync(indexPath, join(distDir, "f", "index.html"));
console.log("Created form entry:", join(distDir, "f", "index.html"));
