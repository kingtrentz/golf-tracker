// Site settings. Edit names, colors, and title here.
// supabaseUrl / supabaseAnonKey come from Supabase > Project Settings > API.
// The anon key is meant to be public; the database rules decide who can write.
// Leave them blank to run the site on demo data.
window.GOLF_CONFIG = {
  siteTitle: "McGrath Masters",
  tagline: "Trent vs Dad vs Logan",
  supabaseUrl: "https://vqgyeqrjvghrzxrirkff.supabase.co",
  supabaseAnonKey: "sb_publishable_pS1HaPnUl9XG3E9uusrQHw_cbul3r1I",
  players: [
    { slug: "trent", name: "Trent", color: "#3987e5" },
    { slug: "dad",   name: "Dad",   color: "#d95926" },
    { slug: "logan", name: "Logan", color: "#199e70" }
  ]
};
