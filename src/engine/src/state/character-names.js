/** Genre-specific name pools used by random character generation. */
export const CHARACTER_NAME_POOLS = Object.freeze({
    fantasy: Object.freeze({
        firstNames: Object.freeze([
            'Aurelia', 'Celestia', 'Evangeline', 'Isolde', 'Seraphina', 'Valeriana', 'Genevieve', 'Rosalind',
            'Alistair', 'Balthazar', 'Cassian', 'Dorian', 'Gideon', 'Lucian', 'Percival', 'Thaddeus',
            'Aerielle', 'Lirael', 'Melanthe', 'Nimue', 'Sylvanas', 'Yvaine',
            'Aelion', 'Caelen', 'Faelar', 'Haldir', 'Theron', 'Zephyrus',
            'Brida', 'Dagmar', 'Freya', 'Helga', 'Vala',
            'Balin', 'Borin', 'Daelin', 'Gimli', 'Thorin', 'Ulfric',
            'Lysandra', 'Elowen', 'Evadne', 'Cormac', 'Rowan', 'Tadhg', 'Fionnuala', 'Kieran', 'Ianthe', 'Silvan',
        ]),
        surnames: Object.freeze([
            'Blackwood', 'Ironheart', 'Ravencrest', 'Winterborne', 'Hawthorn', 'Sterling',
            'Moonwhisper', 'Sunstrider', 'Starweaver', 'Leafrunner', 'Swiftriver', 'Windrunner',
            'Anvilbreaker', 'Deepforge', 'Ironfoot', 'Stonehewer', 'Coppervein', 'Bouldercrag',
            'High-Tower', 'Star-Gazer', 'Sun-Shatter', 'Crown-Guard', 'Moon-Crest', 'Silver-Vein',
            'Moss-Cloak', 'Green-Bough', 'Glen-Strider', 'River-Bend',
        ]),
    }),
    realistic: Object.freeze({
        firstNames: Object.freeze([
            'Eleanor', 'Clara', 'Audrey', 'Evelyn', 'Violet', 'Grace',
            'Alexander', 'Benjamin', 'Henry', 'James', 'Thomas', 'William',
            'Harper', 'Maya', 'Nova', 'Rowan', 'Stella', 'Wren',
            'Asher', 'Ezra', 'Kai', 'Leo', 'Oliver', 'Silas',
            'Harlow', 'Margot', 'Ramona', 'Sloane', 'Tess', 'Zora',
            'Axel', 'Cruz', 'Dax', 'Felix', 'Jude', 'Nico',
            'Sarah', 'John', 'Karen', 'Keith', 'Rachel', 'David', 'Laura', 'Mark', 'Jennifer', 'Paul', 'Megan',
            'Brian', 'Lisa', 'Eric', 'Chloe', 'Jordan', 'Alex', 'Connor', 'Hannah', 'Dylan', 'Jessica', 'Nathan',
            'Ashley', 'Tyler', 'Casey', 'Beth', 'Wayne', 'Rita', 'Frank', 'Donna', 'Ray', 'Brenda', 'Clint', 'Paula', 'Dean',
        ]),
        surnames: Object.freeze([
            'Miller', 'Davis', 'Wilson', 'Taylor', 'Anderson', 'White',
            'Hayes', 'Brooks', 'Mercer', 'Vance', 'Reed', 'Bennett',
            'Sterling', 'Callahan', 'Cross', 'Wilder', 'Slate',
            'Gallagher', 'Burke',
        ]),
    }),
    scifi: Object.freeze({
        firstNames: Object.freeze([
            'Jax', 'Nova', 'Vex', 'Zero', 'Kael', 'Ryn',
            'Cassiopeia', 'Astraea', 'Lyra', 'Vespera', 'Callisto',
            'Orion', 'Cassian', 'Zephyr', 'Phoenix',
            'ARIA-7', 'UNIT-88', 'Echo-9', 'K-42', 'Syn-1',
            'Xylar', "Q'ron", 'Zaelen', 'Vaelis',
            'Tamara', 'Marcus', 'Nadia', 'Derek', 'Rebecca', 'Grant', 'Elena', 'Boris', 'Sarah', 'Victor',
            'Astrid', 'Soren', 'Linnea', 'Aris', 'Naomi', 'Hiroshi', 'Sonya', 'Anton', 'Petrov',
        ]),
        surnames: Object.freeze([
            'Vance', 'Chen', 'Kowalski', 'Takahashi', 'Mercer',
            'Tyrell', 'Matrix', 'Syndicate', 'Nexus', 'Apex', 'Solano',
            'Nova Prime', 'Kepler-4', 'Aegis', 'Triton', 'Cygnus',
            'Cross', 'Stone', 'Novak', 'Sterling', 'Lindholm', 'Tanaka',
            'Vanguard', 'Sector', 'Cipher', 'Ares-3', 'Orbital-9', 'Titan Base',
        ]),
    }),
    horror: Object.freeze({
        firstNames: Object.freeze([
            'Abigail', 'Cordelia', 'Hester', 'Lenore', 'Tabitha', 'Prudence',
            'Bartholomew', 'Edmund', 'Malachi', 'Silas', 'Thaddeus', 'Zebulon',
            'Annabelle', 'Pearl', 'Sadie', 'Mercy', 'Ruth',
            'Caleb', 'Eli', 'Gideon', 'Jasper', 'Levi',
            'Amos', 'Clara', 'Jude', 'Martha', 'Orson', 'Silas',
            'Thomas', 'Samuel', 'Joseph', 'Isaac', 'Nathaniel', 'Diane', 'Gary', 'Pamela', 'Alan', 'Carol', 'Roy',
            'Lyle', 'Nancy', 'Dennis',
        ]),
        surnames: Object.freeze([
            'Blackwood', 'Crane', 'Holloway', 'Ravenscroft', 'Winter', 'Graves',
            'Carver', 'Early', 'Meeks', 'Slaughter',
            'Finch', 'Pest', 'Mallow', 'Skeleton', 'Wormwood',
            'Hale', 'Pyncheon', 'Mather', 'Sewall', 'Danforth', 'Giddings', 'Skeeter', 'Slagged', 'Coffin',
        ]),
    }),
});

const FALLBACK_GENRE = 'fantasy';
const unique = (items) => [...new Set(items)];

/** Names contributed to Character Creator's genre-agnostic random-name button. */
export const CHARACTER_CREATOR_NAME_ADDITIONS = Object.freeze({
    firstNames: Object.freeze(unique(Object.values(CHARACTER_NAME_POOLS).flatMap(pool => pool.firstNames))),
    surnames: Object.freeze(unique(Object.values(CHARACTER_NAME_POOLS).flatMap(pool => pool.surnames))),
});

/** @returns {number} a value in [0, 1) */
function secureRandom() {
    if (globalThis.crypto?.getRandomValues) {
        const values = new Uint32Array(1);
        globalThis.crypto.getRandomValues(values);
        return values[0] / 0x100000000;
    }
    return Math.random();
}

/**
 * Choose a first-name / surname combination from one genre pool.
 * @param {string} genre
 * @param {() => number} [random]
 * @returns {string}
 */
export function pickGenreCharacterName(genre, random = secureRandom) {
    const pool = CHARACTER_NAME_POOLS[genre] || CHARACTER_NAME_POOLS[FALLBACK_GENRE];
    const first = pool.firstNames[Math.min(pool.firstNames.length - 1, Math.floor(random() * pool.firstNames.length))];
    const surname = pool.surnames[Math.min(pool.surnames.length - 1, Math.floor(random() * pool.surnames.length))];
    return `${first} ${surname}`;
}
