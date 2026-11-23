import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";

const root = ReactDOM.createRoot(document.getElementById("root")!);

// Formulário público, sem login e sem carregar o CRO inteiro:
//   croengine.pro/f/?<endereço>   (funciona em qualquer servidor de arquivos)
//   croengine.pro/f/<endereço>    (quando o servidor devolve o index.html para qualquer caminho)
function formSlug(): string | null {
  const { pathname, search } = window.location;
  const byPath = pathname.match(/^\/f\/([a-z0-9-]{3,60})\/?$/i);
  if (byPath) return byPath[1].toLowerCase();
  if (!/^\/f\/?(index\.html)?$/i.test(pathname)) return null;
  const params = new URLSearchParams(search);
  const named = params.get("f") || params.get("form");
  if (named && /^[a-z0-9-]{3,60}$/i.test(named)) return named.toLowerCase();
  for (const [k, v] of params) if (!v && /^[a-z0-9-]{3,60}$/i.test(k)) return k.toLowerCase();
  return null;
}
const slug = formSlug();
const formMatch = slug ? [slug, slug] : null;

if (formMatch) {
  const PublicFormPage = lazy(() => import("./forms/public-page").then((m) => ({ default: m.PublicFormPage })));
  root.render(
    <React.StrictMode>
      <Suspense fallback={null}><PublicFormPage slug={formMatch[1].toLowerCase()} /></Suspense>
    </React.StrictMode>,
  );
} else {
  void Promise.all([import("./App"), import("./styles/app.css")]).then(([{ App }]) => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
}
