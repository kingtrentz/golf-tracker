// Site settings. Edit names, colors, and title here.
// supabaseUrl / supabaseAnonKey come from Supabase > Project Settings > API.
// The anon key is meant to be public; the database rules decide who can write.
// Leave them blank to run the site on demo data.
window.GOLF_CONFIG = {
  siteTitle: "The McGrath Masters",
  tagline: "Trent vs Logan vs Dad",
  supabaseUrl: "https://vqgyeqrjvghrzxrirkff.supabase.co",
  supabaseAnonKey: "sb_publishable_pS1HaPnUl9XG3E9uusrQHw_cbul3r1I",
  // Course a club opens on when it has more than one (otherwise the one played most).
  defaultCourses: { "Hermitage Golf Course": "General's Retreat" },
  players: [
    { slug: "trent", name: "Trent", color: "#3987e5" },
    { slug: "logan", name: "Logan", color: "#ef7d22" },
    { slug: "dad",   name: "Dad",   color: "#d63a3a" }
  ]
};
