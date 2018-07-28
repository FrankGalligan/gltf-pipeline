'use strict';
var Cesium = require('cesium');
var dracoAnim = require('draco-animation');
var ForEach = require('./ForEach');
var addExtensionsRequired = require('./addExtensionsRequired');
var addToArray = require('./addToArray');
var numberOfComponentsForType = require('./numberOfComponentsForType');
var readAccessorPacked = require('./readAccessorPacked');

var defaultValue = Cesium.defaultValue;
var defined = Cesium.defined;
var RuntimeError = Cesium.RuntimeError;

// Prepare encoder for compressing meshes.
var encoderModule = dracoAnim.createEncoderModule({});

module.exports = compressDracoAnimations;

// duplicate all properities except the bufferView that contains the data.
// And then add the accessor to gltf and replace all input/output that uses
// the old accessor.
function removeDataAndReplaceAccessor(gltf, oldAccessorIdString) {
    var oldAccessor = gltf.accessors[oldAccessorIdString];
    var newAccessor = {
        componentType : oldAccessor.componentType,
        count : oldAccessor.count,
        max : oldAccessor.max,
        min : oldAccessor.min,
        type : oldAccessor.type
    };

    var oldAccessorId = parseInt(oldAccessorIdString);
    var newAccessorId = addToArray(gltf.accessors, newAccessor);
    ForEach.animation(gltf, function(animation) {
        ForEach.animationSampler(animation, function(sampler) {
            if (sampler.input === oldAccessorId) {
                sampler.input = newAccessorId;
            }
            if (sampler.output === oldAccessorId) {
                sampler.output = newAccessorId;
            }
        });
    });
    return newAccessorId;
}

// Go through all accessors and replace them with new accessors that
// don't have bufferViews.
function removeAllSamplerAccessorData(gltf, extractedAnimations) {
    var replacedAccessors = [];
    for (var input in extractedAnimations) {
        // Every input here should always be unique or undefined.
        if (defined(replacedAccessors[input])) {
            throw new RuntimeError("Error: Duplicated input in animation extension.");
        }

        extractedAnimations[input].input = removeDataAndReplaceAccessor(gltf, input);
        replacedAccessors[input] = extractedAnimations[input].input;

        var outputs = extractedAnimations[input].outputs;
        for (var i = 0; i < outputs.length; ++i) {
            var output = outputs[i];
            if (defined(replacedAccessors[output])) {
                throw new RuntimeError("Error: Duplicated output in animation extension.");
            }

            outputs[i] = removeDataAndReplaceAccessor(gltf, output);
            replacedAccessors[output] = outputs[i];
        }
    }
}

// Add an compressed animation. The gathered array of compressed animations will
// be added to gltf.extensions.Draco_animation_compression later.
function addCompressedAnimation(gltf, compressedAnimation, encodedLen, encodedData) {
    var buffer = {
        byteLength : encodedLen,
        extras : {
            _pipeline : {
                extension : '.bin',
                source :encodedData
            }
        }
    };
    var bufferId = addToArray(gltf.buffers, buffer);
    var bufferView = {
        buffer : bufferId,
        byteOffset : 0,
        byteLength : encodedLen
    };
    var bufferViewId = addToArray(gltf.bufferViews, bufferView);

    compressedAnimation.bufferView = bufferViewId;
}

function compressDracoAnimations(gltf, options) {
    options = defaultValue(options, {});
    var dracoAnimationOptions = defaultValue(options.dracoAnimationOptions, {});
    var timestampsQuantization = defaultValue(dracoAnimationOptions.quantizeTimestamps, 16);
    var keyframesQuantization = defaultValue(dracoAnimationOptions.quantizeKeyframes, 16);

    // We extract animations from glTF and combine them if they
    // have the same input acccessor.
    var extractedAnimations = {};
    var extractedAnimationCount = 0;

    ForEach.animation(gltf, function(animation) {
        ForEach.animationSampler(animation, function(sampler) {
            if (!defined(sampler.input) || !defined(sampler.output)) {
                throw new RuntimeError("Error: Animation missing input/output.");
            }

            if (!defined(sampler.interpolation)) {
                throw new RuntimeError("Error: Animation missing interpolation method.");
            }

            extractedAnimationCount++;
            if (!defined(extractedAnimations[sampler.input])) {
                extractedAnimations[sampler.input] = {};
                extractedAnimations[sampler.input].input = sampler.input;
                extractedAnimations[sampler.input].outputs = [ sampler.output ];
            } else {
                // TODO: Check if already added.
                extractedAnimations[sampler.input].outputs.push(sampler.output);
            }
        });
    });

    if (extractedAnimationCount === 0) {
        return gltf;
    }

    addExtensionsRequired(gltf, 'Draco_animation_compression');

    for (var input in extractedAnimations) {
        var encoder = new encoderModule.AnimationEncoder();
        var animationBuilder = new encoderModule.AnimationBuilder();
        var dracoAnimation = new encoderModule.KeyframeAnimation();

        // Prepare timestamps data.
        var timestampsData = readAccessorPacked(gltf, gltf.accessors[input]);

        var numKeyframes = timestampsData.length;
        animationBuilder.SetTimestamps(dracoAnimation, numKeyframes, timestampsData);

        var outputs = extractedAnimations[input].outputs;
        extractedAnimations[input].attributesId = [];
        outputs.forEach(function (output) {
            var numComponents = numberOfComponentsForType(gltf.accessors[output].type);
            var packed = readAccessorPacked(gltf, gltf.accessors[output]);

            var keyframeAnimation = new Float32Array(packed);
            var attributeId = animationBuilder.AddKeyframes(dracoAnimation, numKeyframes,
                numComponents, keyframeAnimation);
            if (attributeId <= 0) {
                throw new RuntimeError("Error: Failed adding new keyframes data.");
            }
            extractedAnimations[input].attributesId.push(attributeId);
        });

        var encodedDracoDataArray = new encoderModule.DracoInt8Array();

        // Set quantization bits for the timestamps and keyframres.
        encoder.SetTimestampsQuantization(timestampsQuantization);
        encoder.SetKeyframesQuantization(keyframesQuantization);
        var encodedLen = encoder.EncodeAnimationToDracoBuffer(dracoAnimation, encodedDracoDataArray);
        if (encodedLen <= 0) {
            throw new RuntimeError("Error: Encoding failed.");
        }
        var encodedData = Buffer.alloc(encodedLen);
        for (var i = 0; i < encodedLen; i++) {
            encodedData[i] = encodedDracoDataArray.GetValue(i);
        }

        encoderModule.destroy(dracoAnimation);
        encoderModule.destroy(encoder);
        encoderModule.destroy(animationBuilder);

        addCompressedAnimation(gltf, extractedAnimations[input], encodedLen, encodedData);
    }

    removeAllSamplerAccessorData(gltf, extractedAnimations);

    // Here we add gathered compressed animations to extension.
    var extensions = gltf.extensions;
    if (!defined(gltf.extensions)) {
        extensions = {};
        gltf.extensions = extensions;
    }
    if (!defined(extensions.Draco_animation_compression)) {
        extensions.Draco_animation_compression = [];
    }
    for (var inputAnimation in extractedAnimations) {
        extensions.Draco_animation_compression.push(extractedAnimations[inputAnimation]);
    }

    return gltf;
}
