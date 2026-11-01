export const THEME_STORAGE_KEY = 'dopilot.theme';

/**
 * Applied before first paint, to avoid a flash of the wrong theme. Separate from the
 * components so server-rendered layouts can import it.
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;
