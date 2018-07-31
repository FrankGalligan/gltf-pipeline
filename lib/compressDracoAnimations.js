'use strict';
var Cesium = require('cesium');
var dracoAnim = require('draco-animation');
var fs = require('fs');
var fsExtra = require('fs-extra');
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

function buildPlyBuffer(numPoints, timestampBuffer, dataBufferList, dataComponents) {
    var totalComponents = 1; // Add 1 for timestamp data
    for (var compIndex = 0; compIndex < dataComponents.length; compIndex++) {
        totalComponents += dataComponents[compIndex];
    }

    var buf = Buffer.alloc(numPoints * totalComponents * 32);
    var bytesWritten = 0;

    for (var pointIndex = 0; pointIndex < numPoints; pointIndex++) {
        bytesWritten += buf.write(timestampBuffer[pointIndex].toString(), bytesWritten);
        bytesWritten += buf.write(' ', bytesWritten);

        for (var attrIndex = 0; attrIndex < dataBufferList.length; attrIndex++) {
            var numComponents = dataComponents[attrIndex];
            var dataBuffer = dataBufferList[attrIndex];
            var dataOffset = pointIndex * numComponents;

            for (var componentIndex = 0; componentIndex < numComponents; componentIndex++) {
                bytesWritten += buf.write(dataBuffer[dataOffset + componentIndex].toString(), bytesWritten);
                bytesWritten += buf.write(' ', bytesWritten);
            }
        }
        bytesWritten += buf.write('\n', bytesWritten);
    }

    var outputBuffer = buf.slice(0, bytesWritten);
    return outputBuffer;
}

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
        if (extractedAnimations.hasOwnProperty(input)) {
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
    var plyOutputDir = defaultValue(dracoAnimationOptions.outputPlyDirectory, '.');

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
        if (extractedAnimations.hasOwnProperty(input)) {
            var encoder = new encoderModule.AnimationEncoder();
            var animationBuilder = new encoderModule.AnimationBuilder();
            var dracoAnimation = new encoderModule.KeyframeAnimation();

            // Prepare timestamps data.
            var timestampsData = readAccessorPacked(gltf, gltf.accessors[input]);

            var numKeyframes = timestampsData.length;
            animationBuilder.SetTimestamps(dracoAnimation, numKeyframes, timestampsData);

            var buf = Buffer.alloc(4096);
            var bytesWritten = 0;
            bytesWritten += buf.write('ply\n', bytesWritten);
            bytesWritten += buf.write('format ascii 1.0\n', bytesWritten);
            bytesWritten += buf.write('element vertex ', bytesWritten);
            bytesWritten += buf.write(numKeyframes.toString(), bytesWritten);
            bytesWritten += buf.write('\n', bytesWritten);

            // timestamp value
            bytesWritten += buf.write('property float timestamp\n', bytesWritten);

            var dataBuffers = [];
            var dataComponents = [];

            var outputs = extractedAnimations[input].outputs;
            extractedAnimations[input].attributesId = [];
            for (var outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
                var output = outputs[outputIndex];
                var numComponents = numberOfComponentsForType(gltf.accessors[output].type);
                var packed = readAccessorPacked(gltf, gltf.accessors[output]);

                for (var componentIndex = 0; componentIndex < numComponents; componentIndex++) {
                    bytesWritten += buf.write('property float output-', bytesWritten);
                    bytesWritten += buf.write(outputIndex.toString(), bytesWritten);
                    bytesWritten += buf.write('_component-', bytesWritten);
                    bytesWritten += buf.write(componentIndex.toString(), bytesWritten);
                    bytesWritten += buf.write('\n', bytesWritten);
                }

                dataBuffers.push(packed);
                dataComponents.push(numComponents);

                var keyframeAnimation = new Float32Array(packed);
                var attributeId = animationBuilder.AddKeyframes(dracoAnimation, numKeyframes,
                    numComponents, keyframeAnimation);
                if (attributeId <= 0) {
                    throw new RuntimeError("Error: Failed adding new keyframes data.");
                }
                extractedAnimations[input].attributesId.push(attributeId);
            }

            bytesWritten += buf.write('element face 0\n', bytesWritten);
            bytesWritten += buf.write('property list uchar int vertex_indices\n', bytesWritten);
            bytesWritten += buf.write('end_header\n', bytesWritten);
            var headerBuffer = buf.slice(0, bytesWritten);
            var dataBuffer = buildPlyBuffer(numKeyframes, timestampsData, dataBuffers, dataComponents);

            var filename = plyOutputDir + '/animation_input_' + input;
            console.log('filename:' + filename);
            console.log('headerBuffer.length:' + headerBuffer.length);
            console.log('dataBuffer.length:' + dataBuffer.length);

            var totalLength = headerBuffer.length + dataBuffer.length;
            var plyAsciiBuffer = Buffer.concat([headerBuffer, dataBuffer], totalLength);
            fsExtra.outputFile(filename, plyAsciiBuffer, undefined);

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
        if (extractedAnimations.hasOwnProperty(inputAnimation)) {
            extensions.Draco_animation_compression.push(extractedAnimations[inputAnimation]);
        }
    }

    return gltf;
}
