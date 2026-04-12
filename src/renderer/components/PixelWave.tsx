import { useEffect, useRef } from "react";

/**
 * Animated dot-matrix wave canvas — Nous Research aesthetic.
 * Renders a grid of dots that undulate like a 3D fabric mesh.
 * Detects light/dark mode via the `.dark` class on documentElement.
 */
export function PixelWave() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    const startTime = performance.now();

    const SPACING = 14;
    const BASE_RADIUS = 1.2;

    // Wave parameters — layered sines for organic feel
    const waves = [
      { freqX: 0.025, freqY: 0.015, speed: 0.0008, amp: 6 },
      { freqX: 0.018, freqY: 0.028, speed: 0.0012, amp: 4 },
      { freqX: 0.035, freqY: 0.02, speed: 0.0006, amp: 3 },
    ];

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = container!.getBoundingClientRect();
      canvas!.width = rect.width * dpr;
      canvas!.height = rect.height * dpr;
      canvas!.style.width = `${rect.width}px`;
      canvas!.style.height = `${rect.height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      const rect = container!.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const t = (performance.now() - startTime) * 0.001; // seconds

      ctx!.clearRect(0, 0, w, h);

      const isDark = document.documentElement.classList.contains("dark");

      // Color channels — orange accent in dark, blue in light
      const r = isDark ? 255 : 33;
      const g = isDark ? 90 : 85;
      const b = isDark ? 31 : 255;
      const opacityMin = isDark ? 0.06 : 0.04;
      const opacityMax = isDark ? 0.5 : 0.25;

      const cols = Math.ceil(w / SPACING) + 2;
      const rows = Math.ceil(h / SPACING) + 2;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const baseX = col * SPACING;
          const baseY = row * SPACING;

          // Sum wave displacements
          let displacement = 0;
          for (const wave of waves) {
            displacement +=
              Math.sin(baseX * wave.freqX + baseY * wave.freqY + t * wave.speed * 1000) * wave.amp;
          }

          // Normalize displacement to [-1, 1] range (max total amp = 13)
          const norm = displacement / 13;

          // Position offset — subtle lateral shift for 3D feel
          const dotX = baseX + norm * 2.5;
          const dotY = baseY + norm * 2.5;

          // Size varies with displacement
          const radius = BASE_RADIUS + norm * 0.6;
          if (radius <= 0.2) continue;

          // Opacity varies with displacement — peaks are brighter
          const opacity = opacityMin + (norm * 0.5 + 0.5) * (opacityMax - opacityMin);

          ctx!.beginPath();
          ctx!.arc(dotX, dotY, radius, 0, Math.PI * 2);
          ctx!.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
          ctx!.fill();
        }
      }

      animId = requestAnimationFrame(draw);
    }

    resize();
    draw();

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}
