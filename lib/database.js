const EnvVar = require('./mongodbenv');

// Function to get all environment variables
const readEnv = async () => {
    try {
        const envVars = await EnvVar.find({});
        const envVarObject = {};
        if (envVars.length === 0) {
            console.warn("No environment variables found in the database. Bot might use defaults.");
        }
        envVars.forEach(envVar => {
            envVarObject[envVar.key] = envVar.value;
        });
        return envVarObject;
    } catch (err) {
        console.error('Error retrieving environment variables from DB:', err.message);
        // Instead of throwing, which might crash the bot if not caught upstream immediately,
        // return an empty object or defaults, allowing the bot to potentially start with fixed defaults.
        // The calling function should be aware of this possibility.
        // For now, we throw to make it explicit that DB read failed.
        throw err;
    }
};

// Function to update or create an environment variable
const updateEnv = async (key, newValue) => {
    try {
        const result = await EnvVar.findOneAndUpdate(
            { key: key },
            { value: newValue },
            { new: true, upsert: true, runValidators: true } // runValidators ensures schema rules are checked
        );

        if (result) {
            console.log(`Successfully updated/created ${key} to ${newValue}`);
            return true;
        } else {
            // This case should ideally not be reached if upsert is true and there are no validation errors
            console.warn(`Environment variable ${key} could not be updated or created.`);
            return false;
        }
    } catch (err) {
        console.error(`Error updating environment variable ${key}:`, err.message);
        return false; // Indicate failure
    }
};

module.exports = {
    readEnv,
    updateEnv
};