'use strict';
var Cesium = require('cesium');
var draco3d = require('draco3d');
var hashObject = require('object-hash');
var addExtensionsRequired = require('./addExtensionsRequired');
var addToArray = require('./addToArray');
var ForEach = require('./ForEach');
var numberOfComponentsForType = require('./numberOfComponentsForType');
var readAccessorPacked = require('./readAccessorPacked');
var removeUnusedElements = require('./removeUnusedElements');
var replaceWithDecompressedPrimitive = require('./replaceWithDecompressedPrimitive');
var splitPrimitives = require('./splitPrimitives');

var fs = require('fs');
var fsExtra = require('fs-extra');

var arrayFill = Cesium.arrayFill;
var Check = Cesium.Check;
var clone = Cesium.clone;
var ComponentDatatype = Cesium.ComponentDatatype;
var defaultValue = Cesium.defaultValue;
var defined = Cesium.defined;
var RuntimeError = Cesium.RuntimeError;
var WebGLConstants = Cesium.WebGLConstants;

// Prepare encoder for compressing meshes.
var encoderModule = draco3d.createEncoderModule({});

module.exports = compressDracoMeshes;

/**
 * Compresses meshes using Draco compression in the glTF model.
 *
 * @param {Object} gltf A javascript object containing a glTF asset.
 * @param {Object} options The same options object as {@link processGltf}
 * @param {Object} options.dracoOptions Options defining Draco compression settings.
 * @param {Number} [options.dracoOptions.compressionLevel=7] A value between 0 and 10 specifying the quality of the Draco compression. Higher values produce better quality compression but may take longer to decompress.
 * @param {Number} [options.dracoOptions.quantizePositionBits=14] A value between 0 and 30 specifying the number of bits used for positions. Lower values produce better compression, but will lose precision. A value of 0 does not set quantization.
 * @param {Number} [options.dracoOptions.quantizeNormalBits=10] A value between 0 and 30 specifying the number of bits used for normals. Lower values produce better compression, but will lose precision. A value of 0 does not set quantization.
 * @param {Number} [options.dracoOptions.quantizeTexcoordBits=12] A value between 0 and 30 specifying the number of bits used for texture coordinates. Lower values produce better compression, but will lose precision. A value of 0 does not set quantization.
 * @param {Number} [options.dracoOptions.quantizeColorBits=8] A value between 0 and 30 specifying the number of bits used for color attributes. Lower values produce better compression, but will lose precision. A value of 0 does not set quantization.
 * @param {Number} [options.dracoOptions.quantizeGenericBits=12] A value between 0 and 30 specifying the number of bits used for skinning attributes (joint indices and joint weights) and custom attributes. Lower values produce better compression, but will lose precision. A value of 0 does not set quantization.
 * @param {Boolean} [options.dracoOptions.unifiedQuantization=false] Quantize positions, defined by the unified bounding box of all primitives. If not set, quantization is applied separately.
 * @returns {Object} The glTF asset with compressed meshes.
 *
 * @private
 */
function compressDracoMeshes(gltf, options) {
    options = defaultValue(options, {});
    var dracoOptions = defaultValue(options.dracoOptions, {});
    var defaults = compressDracoMeshes.defaults;
    var compressionLevel = defaultValue(dracoOptions.compressionLevel, defaults.compressionLevel);
    var quantizePositionBits = defaultValue(dracoOptions.quantizePositionBits, defaults.quantizePositionBits);
    var quantizeNormalBits = defaultValue(dracoOptions.quantizeNormalBits, defaults.quantizeNormalBits);
    var quantizeTexcoordBits = defaultValue(dracoOptions.quantizeTexcoordBits, defaults.quantizeTexcoordBits);
    var quantizeColorBits = defaultValue(dracoOptions.quantizeColorBits, defaults.quantizeColorBits);
    var quantizeGenericBits = defaultValue(dracoOptions.quantizeGenericBits, defaults.quantizeGenericBits);
    var unifiedQuantization = defaultValue(dracoOptions.unifiedQuantization, defaults.unifiedQuantization);
    checkRange('compressionLevel', compressionLevel, 0, 10);
    checkRange('quantizePositionBits', quantizePositionBits, 0, 30);
    checkRange('quantizeNormalBits', quantizeNormalBits, 0, 30);
    checkRange('quantizeTexcoordBits', quantizeTexcoordBits, 0, 30);
    checkRange('quantizeColorBits', quantizeColorBits, 0, 30);
    checkRange('quantizeGenericBits', quantizeGenericBits, 0, 30);

    splitPrimitives(gltf);

    var hashPrimitives = {};
    var positionOrigin;
    var positionRange;

    if (unifiedQuantization) {
        // Collect bounding box from all primitives. Currently works only for vec3 positions (XYZ).
        var accessors = gltf.accessors;
        var min = arrayFill(new Array(3), Number.POSITIVE_INFINITY);
        var max = arrayFill(new Array(3), Number.NEGATIVE_INFINITY);
        ForEach.accessorWithSemantic(gltf, 'POSITION', function(accessorId) {
            var accessor = accessors[accessorId];
            if (accessor.type !== 'VEC3') {
                throw new RuntimeError('Could not perform unified quantization. Input contains position accessor with an unsupported number of components.');
            }
            var accessorMin = accessor.min;
            var accessorMax = accessor.max;
            for (var j = 0; j < 3; ++j) {
                min[j] = Math.min(min[j], accessorMin[j]);
                max[j] = Math.max(max[j], accessorMax[j]);
            }
        });
        positionOrigin = min;
        positionRange = Math.max(max[0] - min[0], Math.max(max[1] - min[1], max[2] - min[2]));
    }

    var addedExtension = false;
    var meshIndex = -1;
    var primitiveIndex = -1;

    ForEach.mesh(gltf, function(mesh) {
        meshIndex++;

        var maxNumberPrimitiveAttributes = 0;
        var totalNumberOfMeshVertsWritten = 1;
        var posBufferMesh = Buffer.alloc(0);
        var normBufferMesh = Buffer.alloc(0);
        var texBufferMesh = Buffer.alloc(0);
        var faceBufferMesh = Buffer.alloc(0);

        ForEach.meshPrimitive(mesh, function(primitive) {
            primitiveIndex++;
            console.log('mesh:' + meshIndex + ' primitive:' + primitiveIndex);

            if (defined(primitive.mode) && primitive.mode !== WebGLConstants.TRIANGLES) {
                return;
            }
            if (!defined(primitive.indices)) {
                return;
            }

            addedExtension = true;

            var primitiveGeometry = {
                attributes: primitive.attributes,
                indices: primitive.indices,
                mode: primitive.mode
            };
            var hashValue = hashObject(primitiveGeometry);
            if (defined(hashPrimitives[hashValue])) {
                // Copy compressed primitive.
                copyCompressedExtensionToPrimitive(primitive, hashPrimitives[hashValue]);
                return;
            }
            hashPrimitives[hashValue] = primitive;

            var objName = options.dracoOptions.gltf2ObjDirectory;
            objName += '/gltf_mesh-' + meshIndex.toString() + '_primitive-' + primitiveIndex.toString() + '.obj';
            console.log('gltf2ObjDirectory: ' + options.dracoOptions.gltf2ObjDirectory + ' objName: ' + objName);

            var encoder = new encoderModule.Encoder();
            var meshBuilder = new encoderModule.MeshBuilder();
            var mesh = new encoderModule.Mesh();

            // First get the faces and add to geometry.
            var indicesData = readAccessorPacked(gltf, gltf.accessors[primitive.indices]);
            var indices = new Uint32Array(indicesData);
            var numberOfFaces = indices.length / 3;
            meshBuilder.AddFacesToMesh(mesh, numberOfFaces, indices);

            var posBuffer = Buffer.alloc(0);
            var normBuffer = Buffer.alloc(0);
            var colorBuffer = undefined;
            var texBuffer = Buffer.alloc(0);
            var genericBuffer = undefined;
            var lastNumberOfPoints = 0;

            // Add attributes to mesh.
            var attributeToId = {};
            ForEach.meshPrimitiveAttribute(primitive, function(accessorId, semantic) {
                var accessor = gltf.accessors[accessorId];
                var componentType = accessor.componentType;
                var numberOfPoints = accessor.count;
                var numberOfComponents = numberOfComponentsForType(accessor.type);
                var packed = readAccessorPacked(gltf, accessor);
                var addAttributeFunctionName = getAddAttributeFunctionName(componentType);
                var data = ComponentDatatype.createTypedArray(componentType, packed);
                lastNumberOfPoints = numberOfPoints;

                var attributeName = semantic;
                if (semantic.indexOf('_') > 0) { // Skip user-defined semantics prefixed with underscore
                    attributeName = attributeName.substring(0, semantic.indexOf('_'));
                }

                var attributeEnum;
                if (attributeName === 'POSITION' || attributeName === 'NORMAL' || attributeName === 'COLOR') {
                    attributeEnum = encoderModule[attributeName];
                } else if (attributeName === 'TEXCOORD') {
                    attributeEnum = encoderModule.TEX_COORD;
                } else {
                    attributeEnum = encoderModule.GENERIC;
                }

                if (attributeName === 'POSITION') {
                    posBuffer = outputAttribute(numberOfPoints, numberOfComponents, 'v ', data);
                    var newLength = posBuffer.length + posBufferMesh.length;
                    posBufferMesh = Buffer.concat([posBufferMesh, posBuffer], newLength);
                } else if (attributeName === 'TEXCOORD') {
                    texBuffer = outputAttribute(numberOfPoints, numberOfComponents, 'vt ', data);
                    var newLength = texBuffer.length + texBufferMesh.length;
                    texBufferMesh = Buffer.concat([texBufferMesh, texBuffer], newLength);
                } else if (attributeName === 'NORMAL') {
                    normBuffer = outputAttribute(numberOfPoints, numberOfComponents, 'vn ', data);
                    var newLength = normBuffer.length + normBufferMesh.length;
                    normBufferMesh = Buffer.concat([normBufferMesh, normBuffer], newLength);
                } else if (attributeName === 'COLOR') {
                    console.log('Skipping COLOR no support in obj writing.');
                } else if (attributeName === 'GENERIC') {
                    console.log('Skipping GENERIC no support in obj writing.');
                }

                var attributeId = meshBuilder[addAttributeFunctionName](mesh, attributeEnum, numberOfPoints, numberOfComponents, data);

                if (attributeId === -1) {
                    throw new RuntimeError('Error: Failed adding attribute ' + semantic);
                } else {
                    attributeToId[semantic] = attributeId;
                }
            });

            var attributesOutputList = [false];
            var numberOfAttributesToOutput = 0;
            if (posBuffer.length > 0) {
                numberOfAttributesToOutput++;
            }
            if (texBuffer.length > 0) {
                numberOfAttributesToOutput++;
            }
            if (normBuffer.length > 0) {
                numberOfAttributesToOutput++;
            }

            if (maxNumberPrimitiveAttributes > 0 &&
                maxNumberPrimitiveAttributes < numberOfAttributesToOutput) {
              console.log('Warning: Obj file will most likely be broken.');
              console.log('maxNumberPrimitiveAttributes: ' + maxNumberPrimitiveAttributes.toString() +
                          '< numberOfAttributesToOutput: ' + numberOfAttributesToOutput.toString());
            } else if (maxNumberPrimitiveAttributes == 0) {
              // Record max number of attributes for writing of face buffers. This will work if next primitives have <= num attributes.
              maxNumberPrimitiveAttributes = numberOfAttributesToOutput;
            }

            var attributesOutputList = [false];
            if (posBuffer.length > 0) {
                attributesOutputList[0] = true;
            }
            if (texBuffer.length > 0) {
                attributesOutputList.push(true);
            } else if (maxNumberPrimitiveAttributes >= 2) {
              // No texture attribute for this primitive, need to append a false to skip during face writing.
              attributesOutputList.push(false);
            }
            if (normBuffer.length > 0) {
                attributesOutputList.push(true);
            } else if (maxNumberPrimitiveAttributes >= 3) {
              // No normal attribute for this primitive, need to append a false to skip during face writing.
              attributesOutputList.push(false);
            }

            var faceBuffer = outputFaces(numberOfFaces, numberOfAttributesToOutput, 'f ', indices, 1);
            var subobjName = 'primitive-' + primitiveIndex.toString();
            var subobjFaceBuffer = outputFaces2(numberOfFaces, attributesOutputList, 'f ', indices, totalNumberOfMeshVertsWritten, subobjName);
            var newLength = subobjFaceBuffer.length + faceBufferMesh.length;
            faceBufferMesh = Buffer.concat([faceBufferMesh, subobjFaceBuffer], newLength);

            totalNumberOfMeshVertsWritten += lastNumberOfPoints;

            // Un-comment out this code below to output each primitive as a seperate Obj file.
            //var totalLength = posBuffer.length + texBuffer.length + normBuffer.length + faceBuffer.length;
            //var objBuffer = Buffer.concat([posBuffer, texBuffer, normBuffer, faceBuffer], totalLength);
            //fsExtra.outputFile(objName, objBuffer, undefined);

            var encodedDracoDataArray = new encoderModule.DracoInt8Array();
            encoder.SetSpeedOptions(10 - compressionLevel, 10 - compressionLevel);  // Compression level is 10 - speed.
            if (quantizePositionBits > 0) {
                if (unifiedQuantization) {
                    encoder.SetAttributeExplicitQuantization(encoderModule.POSITION, quantizePositionBits, 3, positionOrigin, positionRange);
                } else {
                    encoder.SetAttributeQuantization(encoderModule.POSITION, quantizePositionBits);
                }
            }
            if (quantizeNormalBits > 0) {
                encoder.SetAttributeQuantization(encoderModule.NORMAL, quantizeNormalBits);
            }
            if (quantizeTexcoordBits > 0) {
                encoder.SetAttributeQuantization(encoderModule.TEX_COORD, quantizeTexcoordBits);
            }
            if (quantizeColorBits > 0) {
                encoder.SetAttributeQuantization(encoderModule.COLOR, quantizeColorBits);
            }
            if (quantizeGenericBits > 0) {
                encoder.SetAttributeQuantization(encoderModule.GENERIC, quantizeGenericBits);
            }

            if (defined(primitive.targets)) {
                // Set sequential encoding to preserve order of vertices.
                encoder.SetEncodingMethod(encoderModule.MESH_SEQUENTIAL_ENCODING);
            }

            encoder.SetTrackEncodedProperties(true);
            var encodedLength = encoder.EncodeMeshToDracoBuffer(mesh, encodedDracoDataArray);
            console.log('encodedLength:' + encodedLength.toString());
            if (encodedLength <= 0) {
                throw new RuntimeError('Error: Draco encoding failed.');
            }
            var encodedPointsCount = encoder.GetNumberOfEncodedPoints();
            var encodedFacesCount = encoder.GetNumberOfEncodedFaces();
            var encodedData = Buffer.alloc(encodedLength);
            for (var i = 0; i < encodedLength; ++i) {
                encodedData[i] = encodedDracoDataArray.GetValue(i);
            }

            addCompressionExtensionToPrimitive(gltf, primitive, attributeToId, encodedLength, encodedData, encodedPointsCount, encodedFacesCount);

            encoderModule.destroy(encodedDracoDataArray);
            encoderModule.destroy(mesh);
            encoderModule.destroy(meshBuilder);
            encoderModule.destroy(encoder);
        });

        var totalLength = posBufferMesh.length + texBufferMesh.length + normBufferMesh.length + faceBufferMesh.length;
        var objBufferMesh = Buffer.concat([posBufferMesh, texBufferMesh, normBufferMesh, faceBufferMesh], totalLength);
        var objNameMesh = options.dracoOptions.gltf2ObjDirectory;
        objNameMesh += '/gltf_mesh-' + meshIndex.toString() + '.obj';
        fsExtra.outputFile(objNameMesh, objBufferMesh, undefined);
    });

    if (addedExtension) {
        addExtensionsRequired(gltf, 'KHR_draco_mesh_compression');
        removeUnusedElements(gltf);
    }

    return gltf;
}

function outputAttribute(points, components, prefix, data, base) {
    console.log('points:' + points.toString());
    console.log('components:' + components.toString());

    var buf = Buffer.alloc(points * components * 30);
    var bytesWritten = 0;

    for (var p = 0; p < points; ++p) {
        bytesWritten += buf.write(prefix, bytesWritten);

        for (var c = 0; c < components; ++c) {
            var index = (p * components) + c;
            if (defined(base)) {
                var value = data[index] + base;
                bytesWritten += buf.write(value.toString(), bytesWritten);
            } else {
                bytesWritten += buf.write(data[index].toString(), bytesWritten);
            }
            bytesWritten += buf.write(' ', bytesWritten);
        }
        bytesWritten += buf.write('\n', bytesWritten);
    }
    bytesWritten += buf.write('\n', bytesWritten);

    var outputBuffer = buf.slice(0, bytesWritten);
    return outputBuffer;
}

function outputFaces(faces, attributes, prefix, data, base, subobj) {
    console.log('faces:' + faces.toString());
    console.log('attributes:' + attributes.toString());

    var buf = Buffer.alloc(faces * attributes * 30);
    var bytesWritten = 0;

    if (defined(subobj)) {
      bytesWritten += buf.write('o ', bytesWritten);
      bytesWritten += buf.write(subobj, bytesWritten);
      bytesWritten += buf.write('\n', bytesWritten);
    }

    for (var f = 0; f < faces; ++f) {
        bytesWritten += buf.write(prefix, bytesWritten);

        for (var c = 0; c < 3; ++c) {
            var index = (f * 3) + c;

            var value = data[index];
            if (defined(base)) {
                value = data[index] + base;
            }

            for (var a = 0; a < attributes; ++a) {
                if (a > 0) {
                    bytesWritten += buf.write('/', bytesWritten);
                }
                bytesWritten += buf.write(value.toString(), bytesWritten);
            }
            bytesWritten += buf.write(' ', bytesWritten);
        }
        bytesWritten += buf.write('\n', bytesWritten);
    }
    bytesWritten += buf.write('\n', bytesWritten);

    var outputBuffer = buf.slice(0, bytesWritten);
    return outputBuffer;
}

function outputFaces2(faces, attributesOutputList, prefix, data, base, subobj) {
    console.log('faces:' + faces.toString());
    console.log('attributesOutputList: ' + attributesOutputList.toString());

    var buf = Buffer.alloc(faces * attributesOutputList.length * 30);
    var bytesWritten = 0;

    if (defined(subobj)) {
      bytesWritten += buf.write('o ', bytesWritten);
      bytesWritten += buf.write(subobj, bytesWritten);
      bytesWritten += buf.write('\n', bytesWritten);
    }

    for (var f = 0; f < faces; ++f) {
        bytesWritten += buf.write(prefix, bytesWritten);

        for (var c = 0; c < 3; ++c) {
            var index = (f * 3) + c;

            var value = data[index];
            if (defined(base)) {
                value = data[index] + base;
            }

            for (var a = 0; a < attributesOutputList.length; ++a) {
                if (a > 0) {
                    bytesWritten += buf.write('/', bytesWritten);
                }
                if (attributesOutputList[a])
                  bytesWritten += buf.write(value.toString(), bytesWritten);
            }
            bytesWritten += buf.write(' ', bytesWritten);
        }
        bytesWritten += buf.write('\n', bytesWritten);
    }
    bytesWritten += buf.write('\n', bytesWritten);

    var outputBuffer = buf.slice(0, bytesWritten);
    return outputBuffer;
}

function addCompressionExtensionToPrimitive(gltf, primitive, attributeToId, encodedLength, encodedData, encodedPointsCount, encodedFacesCount) {
    // Remove properties from accessors.
    // Remove indices bufferView.
    var indicesAccessor = clone(gltf.accessors[primitive.indices]);
    delete indicesAccessor.bufferView;
    delete indicesAccessor.byteOffset;
    primitive.indices = addToArray(gltf.accessors, indicesAccessor);

    // Remove attributes bufferViews.
    ForEach.meshPrimitiveAttribute(primitive, function(accessorId, semantic) {
        var attributeAccessor = clone(gltf.accessors[accessorId]);
        delete attributeAccessor.bufferView;
        delete attributeAccessor.byteOffset;
        primitive.attributes[semantic] = addToArray(gltf.accessors, attributeAccessor);
    });

    var buffer = {
        byteLength: encodedLength,
        extras: {
            _pipeline: {
                source: encodedData
            }
        }
    };
    var bufferId = addToArray(gltf.buffers, buffer);
    var bufferView = {
        buffer: bufferId,
        byteOffset: 0,
        byteLength: encodedLength
    };
    var bufferViewId = addToArray(gltf.bufferViews, bufferView);

    primitive.extensions = defaultValue(primitive.extensions, {});
    primitive.extensions.KHR_draco_mesh_compression = {
        bufferView: bufferViewId,
        attributes: attributeToId
    };

    gltf = replaceWithDecompressedPrimitive(gltf, primitive, encodedPointsCount, encodedFacesCount);
}

function copyCompressedExtensionToPrimitive(primitive, compressedPrimitive) {
    ForEach.meshPrimitiveAttribute(compressedPrimitive, function(accessorId, semantic) {
        primitive.attributes[semantic] = accessorId;
    });
    primitive.indices = compressedPrimitive.indices;

    var dracoExtension = compressedPrimitive.extensions.KHR_draco_mesh_compression;
    primitive.extensions = defaultValue(primitive.extensions, {});
    primitive.extensions.KHR_draco_mesh_compression = {
        bufferView: dracoExtension.bufferView,
        attributes: dracoExtension.attributes
    };
}

function getAddAttributeFunctionName(componentType) {
    switch (componentType) {
        case WebGLConstants.UNSIGNED_BYTE:
            return 'AddUInt8Attribute';
        case WebGLConstants.BYTE:
            return 'AddInt8Attribute';
        case WebGLConstants.UNSIGNED_SHORT:
            return 'AddUInt16Attribute';
        case WebGLConstants.SHORT:
            return 'AddInt16Attribute';
        case WebGLConstants.UNSIGNED_INT:
            return 'AddUInt32Attribute';
        case WebGLConstants.INT:
            return 'AddInt32Attribute';
        case WebGLConstants.FLOAT:
            return 'AddFloatAttribute';
    }
}

function checkRange(name, value, minimum, maximum) {
    Check.typeOf.number.greaterThanOrEquals(name, value, minimum);
    Check.typeOf.number.lessThanOrEquals(name, value, maximum);
}

compressDracoMeshes.defaults = {
    compressionLevel: 7,
    quantizePositionBits: 14,
    quantizeNormalBits: 10,
    quantizeTexcoordBits: 12,
    quantizeColorBits: 8,
    quantizeSkinBits: 12,
    quantizeGenericBits: 12,
    unifiedQuantization: false
};
