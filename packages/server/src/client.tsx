/** @jsxImportSource solid-js/h */
import { render } from 'solid-js/web';
import { Shader, Swirl, Dither } from 'shaders/solid';

const root = document.getElementById('shader-bg');

if (root) {
  render(
    () => (
      <Shader style={{ position: 'fixed', inset: '0', 'z-index': '0' }}>
        <Swirl colorA="#000000" colorB="#ffffff" />
        <Dither />
      </Shader>
    ),
    root,
  );
}
