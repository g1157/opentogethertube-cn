/**
 * Component specs assert the complete Chinese interface, which is also what the fork's
 * audience sees by default. Register that pack before any spec mounts: the application
 * does exactly the same fetch in `main.ts` before mounting, so this only pins the test
 * default (U1/PF4). Keeping it out of `i18n.ts` is what stops the production entry chunk
 * from shipping a second complete language pack to every visitor.
 */
import { loadLanguageAsync } from "@/i18n";

await loadLanguageAsync("zh-CN");
