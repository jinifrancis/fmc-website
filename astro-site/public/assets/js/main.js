/**
 * FATHIMA MATHA CHURCH — WEST KORATTY
 * Main JavaScript
 */

// Wait for DOM to be fully loaded
document.addEventListener('DOMContentLoaded', function() {
  // MOBILE MENU
  const menuBtn = document.getElementById('mobBtn');
  const mobileMenu = document.getElementById('mobMenu');

  if (menuBtn && mobileMenu) {
    menuBtn.addEventListener('click', function() {
      mobileMenu.classList.toggle('open');
    });
  }

  // Close mobile menu when link is clicked
  window.closeMob = function() {
    if (mobileMenu) {
      mobileMenu.classList.remove('open');
    }
  };

  // SCROLL REVEAL ANIMATION
  const revealElements = document.querySelectorAll('.rv');

  const revealObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
      }
    });
  }, {
    threshold: 0.1
  });

  revealElements.forEach(function(element) {
    revealObserver.observe(element);
  });

  // NAVBAR SHADOW ON SCROLL
  const navbar = document.getElementById('nav');
  window.addEventListener('scroll', function() {
    if (navbar) {
      if (window.scrollY > 40) {
        navbar.style.boxShadow = '0 4px 20px rgba(0,0,0,0.25)';
      } else {
        navbar.style.boxShadow = 'none';
      }
    }
  });

  // FOOTER COPYRIGHT YEAR
  document.getElementById('year').textContent = new Date().getFullYear();
});
