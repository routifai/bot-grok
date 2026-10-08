import { cn } from "@aiden/ui-web";
import { useEffect, useRef, useState } from "react";

// Dense orb: thin anti-aliased flow lines rendered at device resolution (WebGL2, fwidth).
// Shader inspired by "Shader Reminder" by Daniela Muntyan (CC BY 4.0); original implementation.
const VERTEX = `#version 300 es
in vec2 p; void main(){ gl_Position=vec4(p,0.,1.); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 r; uniform float t; uniform float dim; out vec4 o;
float field(vec2 p,float tt){
  float a=sin(p.x*2.1+tt*.55+1.4*sin(p.y*1.7-tt*.33));
  float b=sin(p.y*2.4-tt*.42+1.2*sin(p.x*1.3+tt*.21));
  float c=sin((p.x+p.y)*1.6+tt*.27);
  float d2=sin(length(p)*3.2-tt*.4);
  return a*.55+b*.35+c*.25+d2*.18;
}
float lines(float v,float n){ float x=v*n; float w=fwidth(x); return 1.-smoothstep(.0,1.15*w,abs(fract(x)-.5)); }
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*r)/(.5*min(r.x,r.y));
  float d=length(uv); float R=.80;
  float inside=smoothstep(R+.006,R-.006,d);
  vec2 p=uv*(1.+.42*d*d);
  float f=field(p*1.15,t*.55)+.32*field(p*2.6+4.,t*.8);
  float g=field(p*.9+9.,t*.35);
  float ln=lines(f,9.)*.95+lines(f+.5/9.,9.)*.35;
  float ribbon=exp(-pow(g*2.2,2.))*1.2+.25;
  float rim=pow(smoothstep(.15,R,d),1.4);
  float ang=atan(uv.y,uv.x);
  vec3 col=mix(vec3(.30,.55,1.),vec3(.58,.45,1.),.5+.5*sin(ang*1.1+t*.22));
  col=mix(col,vec3(1.,.45,.74),smoothstep(.15,.9,(-uv.y-uv.x*.5)*.85)*rim);
  col=mix(col,vec3(.78,.88,1.),smoothstep(.6,1.4,ribbon)*.35);
  vec3 c=col*ln*ribbon*(.30+1.05*rim)*inside;
  float halo=exp(-pow(max(d-R,0.)*9.,1.6))*(1.-inside)*.55;
  float outer=lines(field(uv*1.6,t*.45),7.)*exp(-max(d-R,0.)*7.)*(1.-inside)*.35;
  c+=col*(halo*.35+outer); c+=vec3(.02,.022,.04)*inside;
  o=vec4(min(c*dim,vec3(1.)),clamp(max(inside,halo*.6+outer),0.,1.)*dim);
}`;

const STILL_FRAME_SECONDS = 6;

function createDrawer(canvas: HTMLCanvasElement, dim: number) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, antialias: true });
  if (!gl) return null;
  const program = gl.createProgram();
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return false;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean;
  };
  if (!compile(gl.VERTEX_SHADER, VERTEX) || !compile(gl.FRAGMENT_SHADER, FRAGMENT)) return null;
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const resolution = gl.getUniformLocation(program, "r");
  const time = gl.getUniformLocation(program, "t");
  gl.uniform1f(gl.getUniformLocation(program, "dim"), dim);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  return {
    draw(seconds: number) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(resolution, w, h);
      gl.uniform1f(time, seconds);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

/**
 * A decorative line orb for the signed-out page. Animates only while on screen and the tab
 * is visible; under reduced motion it draws one still frame. Without WebGL2 it falls back
 * to a soft radial gradient.
 */
export function DenseOrb({ className, dim = 1 }: { className?: string; dim?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const drawer = createDrawer(canvas, dim);
    if (!drawer) {
      setFallback(true);
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const start = performance.now();
    let onScreen = true;
    let frame = 0;
    const tick = (now: number) => {
      drawer.draw((now - start) / 1000);
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      if (!reduced && onScreen && !document.hidden) frame = requestAnimationFrame(tick);
    };
    if (reduced) drawer.draw(STILL_FRAME_SECONDS);
    const intersection = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      sync();
    });
    const resize = new ResizeObserver(() => reduced && drawer.draw(STILL_FRAME_SECONDS));
    intersection.observe(canvas);
    resize.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      intersection.disconnect();
      resize.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [dim]);

  return (
    <canvas
      ref={ref}
      className={cn(
        fallback &&
          "rounded-full bg-radial-[at_40%_35%] from-welcome-glow/50 via-welcome-glow-lo/30 to-transparent to-70%",
        className,
      )}
    />
  );
}
