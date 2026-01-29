/**
 * APEX-MD Command Handler
 * Commands ලියාපදිංචි කිරීම සහ කළමනාකරණය මෙතනින් සිදුවේ.
 */

var commands = [];

function cmd(info, func) {
    var data = { ...info };
    data.function = func;
    
    // Default අගයන් සැකසීම
    if (!data.dontAddCommandList) data.dontAddCommandList = false;
    if (!data.desc) data.desc = '';
    if (!data.fromMe) data.fromMe = false;
    if (!data.category) data.category = 'misc';
    if (!data.filename) data.filename = "Not Provided";

    // Pattern එකක් නැතිනම් cmdname එක පාවිච්චි කිරීම
    if (!data.pattern && data.cmdname) {
        data.pattern = data.cmdname;
    }

    if (!data.pattern) {
        console.warn(`[WARNING] Command in ${data.filename} is missing a pattern!`);
    }

    commands.push(data);
    return data;
}

module.exports = {
    cmd,
    AddCommand: cmd,
    Function: cmd,
    Module: cmd,
    commands,
};
