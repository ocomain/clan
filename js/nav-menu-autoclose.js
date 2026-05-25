/*
 * nav-menu-autoclose.js
 * ---------------------------------------------------------------------
 * Adds modal-style dismissal behaviour to the mobile hamburger menu
 * across every page that uses .nav-mobile-menu + .nav-hamburger. Drop
 * this script in once per page; each page's existing toggleMenu()
 * implementation continues to handle the actual open/close — this
 * file only adds the auto-close-on-scroll behaviour.
 *
 * Why MutationObserver: pages vary in how toggleMenu is written (some
 * toggle the hamburger class, some don't; some use let, some var,
 * some const). Rather than try to reconcile, we just watch the menu
 * element for the .open class appearing and react accordingly. This
 * stays correct regardless of which toggleMenu implementation runs.
 *
 * Why a 24px scroll displacement: the tap that opens the menu can
 * itself cause a momentary scrollY change of 1–2px on iOS. We require
 * a real scroll movement (24px) before closing, so the menu doesn't
 * dismiss itself the instant it opens.
 */
(function(){
  'use strict';

  function ready(fn){
    if(document.readyState !== 'loading'){ fn(); return; }
    document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function(){
    var menu = document.getElementById('mobile-menu');
    if(!menu) return;

    var openScrollY = null;

    function close(){
      menu.classList.remove('open');
      var btn = document.querySelector('.nav-hamburger');
      if(btn) btn.classList.remove('open');
      openScrollY = null;
    }

    var observer = new MutationObserver(function(mutations){
      for(var i = 0; i < mutations.length; i++){
        var m = mutations[i];
        if(m.attributeName !== 'class') continue;
        if(menu.classList.contains('open') && openScrollY === null){
          openScrollY = window.scrollY;
        } else if(!menu.classList.contains('open')){
          openScrollY = null;
        }
      }
    });
    observer.observe(menu, { attributes: true, attributeFilter: ['class'] });

    window.addEventListener('scroll', function(){
      if(openScrollY === null) return;
      if(Math.abs(window.scrollY - openScrollY) > 24){
        close();
      }
    }, { passive: true });
  });
})();
