/* ===================================================
   RESHIE NOVELTIES & GIFTS LLC — Main JS
   =================================================== */

/* ---- EmailJS config — fill these in after setup ---- */
const EMAILJS_PUBLIC_KEY  = 'QtJy_A2bvkMPyF4wC';   // from emailjs.com → Account → Public Key
const EMAILJS_SERVICE_ID  = 'service_qrhz8ia';   // from Email Services tab
const EMAILJS_TEMPLATE_ID = 'template_a2hjf4k';  // from Email Templates tab

(function () {
  'use strict';

  emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });

  /* ---- Sticky Header ---- */
  const header = document.getElementById('header');
  function onScroll() {
    header.classList.toggle('scrolled', window.scrollY > 60);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---- Mobile Nav Toggle ---- */
  const navToggle = document.getElementById('navToggle');
  const navLinks  = document.getElementById('navLinks');
  navToggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', navLinks.classList.contains('open'));
  });
  // Close on link click
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => navLinks.classList.remove('open'));
  });

  /* ---- Active nav link on scroll ---- */
  const sections = document.querySelectorAll('section[id], div[id]');
  const navItems = document.querySelectorAll('.nav-links a');

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        navItems.forEach(a => a.classList.remove('active'));
        const active = document.querySelector(`.nav-links a[href="#${entry.target.id}"]`);
        if (active) active.classList.add('active');
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px' });

  sections.forEach(s => observer.observe(s));

  /* ---- Contact form — EmailJS ---- */
  const form        = document.getElementById('contactForm');
  const formSuccess = document.getElementById('formSuccess');
  const formError   = document.getElementById('formError');

  if (form) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      formSuccess.classList.remove('visible');
      formError.classList.remove('visible');

      const templateParams = {
        from_name:  form.name.value.trim(),
        from_email: form.email.value.trim(),
        subject:    form.subject.value.trim() || 'Website Enquiry',
        message:    form.message.value.trim(),
      };

      emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams)
        .then(() => {
          form.reset();
          formSuccess.classList.add('visible');
          setTimeout(() => formSuccess.classList.remove('visible'), 6000);
        })
        .catch(() => {
          formError.classList.add('visible');
          setTimeout(() => formError.classList.remove('visible'), 8000);
        })
        .finally(() => {
          btn.disabled = false;
          btn.textContent = 'Send Message';
        });
    });
  }

  /* ---- Fade-in on scroll (IntersectionObserver) ---- */
  const fadeEls = document.querySelectorAll(
    '.collection-card, .pillar, .gallery-item, .about-text, .about-image, .contact-info, .contact-form'
  );

  const fadeObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity    = '1';
        entry.target.style.transform  = 'translateY(0)';
        fadeObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  fadeEls.forEach(el => {
    el.style.opacity   = '0';
    el.style.transform = 'translateY(28px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    fadeObserver.observe(el);
  });

})();
