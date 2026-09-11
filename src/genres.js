/**
 * @readonly
 * @enum {string}
 */
export const genres = [
    "keen"
]

/**
 * @typedef {Object} ParameterFormatProperty
 * @property {string} key Internal identifier for this property
 * @property {string} name Human-readable name for this property
 * @property {('boolean'|'choice'|'number'|'string')} type Type of this property
 * @property {number} [min] Minimum allowed value for numeric or choice properties
 * @property {number} [max] Maximum allowed value for numeric or choice properties
 *
 * @typedef {Object} ParameterFormatCodeComponent
 * @property {string} key Internal identifier for this property
 * @property {string} [prefix] Prefix for string component
 * @property {{[x: (string|number)]: string}} [values] Mapping from internal value to string encoding
 *
 *
 * @typedef {Object} ParameterFormatLabelComponent
 * @property {string} key Internal identifier for this property
 * @property {string} [format] Format for string component, with `{}` substituted for the value
 * @property {{[x: (string|number)]: string}} [values] Mapping from internal value to string encoding
 *
 * @typedef {Object} ParameterFormat
 * @property {ParameterFormatProperty[]} properties Parameters, as sent to the Puzzles midend
 * @property {ParameterFormatCodeComponent[]} codeFormat Format for parameter strings
 * @property {ParameterFormatLabelComponent[]} labelFormat Format for pretty-printing
 *
 * @typedef {Object} GenreInfoEntry
 * @property {string} name
 * @property {string} [description]
 * @property {string} [helpLink] Link to the help page for this puzzle. If undefined, defaults to the empty string.
 * @property {string[]} [rules]
 * @property {any} [controls]
 * @property {ParameterFormat} [params]
 * @property {boolean} [hidden]
 */

/**
 * @type {{[x: genres]: GenreInfoEntry}}
 */
export const genreInfo = {
    "keen": {
        name: "Keen",
        description: "Fill in numbers to satisfy mathematical operations.",
        rules: [
            "Each row and column contains the numbers from 1 to the grid size exactly once.",
            "Each region's numbers, when combined with the indicated operation, must form the indicated value.",
            "If the operation is not specified, the numbers are combined using multiplication.",
            "Regions can contain the same number multiple times."
        ]
    },
    "none": {
        name: "No puzzle loaded",
        description: "Click a puzzle to start it.",
        helpLink: ""
    }
}
