import Packager from "../../src/packager/packager";

test('DEFAULT_OPTIONS', () => {
  expect(Packager.usesUnsafeOptions(Packager.DEFAULT_OPTIONS())).toBe(false);
});

test('custom JS', () => {
  const options = Packager.DEFAULT_OPTIONS();
  options.custom.js = 'alert(1)';
  expect(Packager.usesUnsafeOptions(options)).toBe(true);
});

test('custom CSS', () => {
  const options = Packager.DEFAULT_OPTIONS();
  options.custom.css = 'body { display: none; }';
  expect(Packager.usesUnsafeOptions(options)).toBe(true);
});

test('custom extensions', () => {
  const options = Packager.DEFAULT_OPTIONS();
  options.extensions.push('https://example.com/');
  expect(Packager.usesUnsafeOptions(options)).toBe(true);
});

test('unsafe cloud behaviors', () => {
  const options = Packager.DEFAULT_OPTIONS();
  options.cloudVariables.unsafeCloudBehaviors = true;
  expect(Packager.usesUnsafeOptions(options)).toBe(true);
});

test('default CSP is not unsafe', () => {
  // The UI backfills custom.csp from the default; that must not be flagged as unsafe.
  const options = Packager.DEFAULT_OPTIONS();
  options.custom.csp = Packager.DEFAULT_OPTIONS().custom.csp;
  expect(Packager.usesUnsafeOptions(options)).toBe(false);
});

test('custom CSP', () => {
  const options = Packager.DEFAULT_OPTIONS();
  options.custom.csp = "default-src 'self'";
  expect(Packager.usesUnsafeOptions(options)).toBe(true);
});
