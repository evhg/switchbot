// Server-safe (no 'use client'): inlined into <head> by app/layout.tsx.
/** Runs before first paint (inlined in <head>) so there is no theme flash. Mirrors resolve() in theme.tsx. */
export const THEME_BOOT = `(function(){try{var m='auto';try{var r=localStorage.getItem('sleeplab.themeMode');if(r)m=JSON.parse(r)}catch(e){}
var h=(new Date(Date.now()+252e5)).getUTCHours();var t=m;
if(m==='auto'){t=(h>=21||h<7)?'night':(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}
document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
