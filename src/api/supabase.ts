/**
 * The one place the browser imports supabase-js. auth.ts loads this module
 * with a dynamic import, so the library lands in its own `supabase` chunk
 * that only signed-in visitors (or someone signing in) ever download.
 */
export { createClient } from '@supabase/supabase-js';
