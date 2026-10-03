import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "node_modules/**", "templates/**", "docs/**", "src/db/migrations/**", "next-env.d.ts", "src/integrations/github/templates.generated.ts"] },
];

export default config;
