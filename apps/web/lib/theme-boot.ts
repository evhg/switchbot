// Server-safe (no 'use client'): inlined into <head> by app/layout.tsx.
/** Runs before first paint (inlined in <head>) so there is no theme flash. Mirrors resolve() in theme.tsx and sets
 *  the theme-color meta (status bar / overscroll) to the theme's --bg (THEME_COLOR in theme.tsx).
 *  `?theme=light|dark|night` forces a theme for this page view without persisting (screenshots, §3.5). */
export const THEME_BOOT = `(function(){try{var m='auto';try{var r=localStorage.getItem('sleeplab.themeMode');if(r)m=JSON.parse(r)}catch(e){}
var q=(location.search.match(/[?&]theme=(light|dark|night)/)||[])[1];if(q)m=q;
var h=(new Date(Date.now()+252e5)).getUTCHours();var t=m;
if(m==='auto'){t=(h>=21||h<7)?'night':(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}
var d=document.documentElement;d.setAttribute('data-theme',t);
if('IntersectionObserver' in window){d.setAttribute('data-motion','');setTimeout(function(){if(!d.hasAttribute('data-hydrated'))d.removeAttribute('data-motion')},8000)}
var c=t==='light'?'#f4f3ef':t==='dark'?'#0e0e0f':'#000000';var ms=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<ms.length;i++){ms[i].setAttribute('content',c);ms[i].removeAttribute('media')}}catch(e){}})();`;
