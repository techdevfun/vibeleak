/* global document */
/**
 * SYNTHETIC fixture bundle. Imitates a Lovable-style app that ships its
 * Supabase URL and anon key in JavaScript.
 *
 * - SUPABASE_URL is a placeholder: the fixture server replaces
 *   __SUPABASE_URL__ with its own local address at request time.
 * - SUPABASE_ANON_KEY is a SYNTHETIC JWT: self-signed payload with
 *   role "anon", signature "synthetic-signature". It is not a real key
 *   and grants access to nothing outside the local fixture server.
 * - The fake row values in the fixture server are synthetic too.
 */
const SUPABASE_URL = "__SUPABASE_URL__";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bnRoZXRpYy1yZWYiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc2MzExNjgwMCwiZXhwIjoxODkzNDU2MDAwfQ.c3ludGhldGljLXNpZ25hdHVyZQ";

async function loadPosts() {
  const res = await fetch(
    SUPABASE_URL + "/rest/v1/public_posts?select=*&limit=5",
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
      },
    },
  );
  const posts = await res.json();
  document.getElementById("app").textContent =
    "Loaded " + posts.length + " public posts (synthetic).";
}

loadPosts();
