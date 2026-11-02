/**
 * electron-installer-redhat stages its payload in <_topdir>/BUILD/usr.
 * RPM 4.20+ changes the scriptlet cwd to a per-package subdirectory, so the
 * installer's relative usr/* copy no longer finds it. Keep the staging layout
 * and resolve the source independently of the RPM version's working directory.
 */
const fs = require("fs");

const COPY_COMMAND = "cp <%= process.platform === 'darwin' ? '-R' : '-r' %>";
const ORIGINAL_COPY = `${COPY_COMMAND} usr/* %{buildroot}/usr/`;
const COMPATIBLE_COPY = `${COPY_COMMAND} "%{_topdir}/BUILD/usr/." "%{buildroot}/usr/"`;

function patchRpmSpecTemplate(source) {
  if (source.includes(COMPATIBLE_COPY) && !source.includes(ORIGINAL_COPY)) {
    return { status: "already", code: source };
  }
  if (source.split(ORIGINAL_COPY).length !== 2) {
    throw new Error("Unsupported electron-installer-redhat spec template: expected one staging copy command");
  }
  return { status: "patched", code: source.replace(ORIGINAL_COPY, COMPATIBLE_COPY) };
}

function prepareRpmSpecTemplate(
  templatePath = require.resolve("electron-installer-redhat/resources/spec.ejs"),
) {
  const source = fs.readFileSync(templatePath, "utf8");
  const result = patchRpmSpecTemplate(source);
  if (result.status === "patched") fs.writeFileSync(templatePath, result.code, "utf8");
  return result.status;
}

module.exports = { patchRpmSpecTemplate, prepareRpmSpecTemplate };
