import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";

const root = ReactDOM.createRoot(document.getElementById("root")!);

// croengine.pro/f/<endereço>: formulário público, sem login e sem carregar o CRO inteiro
const formMatch = window.location.pathname.match(/^\/f\/([a-z0-9-]{3,60})\/?$/i);

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
