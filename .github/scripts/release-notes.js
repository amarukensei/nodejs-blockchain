// Prints the notes of a version (like v2.0.0) from CHANGELOG.md, for its release
const fs = require('fs');

const version = process.argv[2].replace(/^v/, '');
const sections = fs.readFileSync('CHANGELOG.md', 'utf8').split(/^## /m).slice(1);
const section = sections.find(text => text.split(/\s/, 1)[0] == version);

if (!section) {
    console.error('CHANGELOG.md has no section for version ' + version);
    process.exit(1);
}
console.log(section.slice(section.indexOf('\n') + 1).trim());
