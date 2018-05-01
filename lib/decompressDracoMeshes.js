'use strict';
var Cesium = require('cesium');
var draco3d = require('draco3d');
var hashObject = require('object-hash');
var ForEach = require('./ForEach');
var addExtensionsRequired = require('./addExtensionsRequired');
var addToArray = require('./addToArray');
var numberOfComponentsForType = require('./numberOfComponentsForType');
var readAccessorPacked = require('./readAccessorPacked');
var removeExtensionsUsed = require('./removeExtensionsUsed');
var removeUnusedElements = require('./removeUnusedElements');

var checkGreaterThanOrEquals = Cesium.Check.typeOf.number.greaterThanOrEquals;
var checkLessThan = Cesium.Check.typeOf.number.lessThan;
var defaultValue = Cesium.defaultValue;
var defined = Cesium.defined;
var DeveloperError = Cesium.DeveloperError;
var arrayFill = Cesium.arrayFill;

var decoderModule = draco3d.createDecoderModule({});

module.exports = decompressDracoMeshes;


/**
 * Compresses meshes using Draco compression in the glTF model.
 *
 * @param {Object} gltf A javascript object containing a glTF asset.
 * @param {Object} options The same options object as {@link processGltf}
 * @param {Object} options.dracoOptions Options defining Draco compression settings.
 * @param {Number} [options.dracoOptions.compressionLevel=7] A value between 0 and 10 specifying the quality of the Draco compression. Higher values produce better quality compression but may take longer to decompress.
 * @param {Number} [options.dracoOptions.quantizePosition=14] A value between 0 and 30 specifying the number of bits used for positions. Lower values produce better compression, but will lose precision. A value of 0 does not set quantization.
 * @param {Number} [options.dracoOptions.quantizeNormal=10] A value between 0 and 30 specifying the number of bits used for normals. Lower values produce better compression, but will lose precision. A value of 0 does not set quantization.
 * @param {Number} [options.dracoOptions.quantizeTexcoord=12] A value between 0 and 30 specifying the number of bits used for texture coordinates. Lower values produce better compression, but will lose precision. A value of 0 does not set quantization.
 * @param {Number} [options.dracoOptions.quantizeColor=8] A value between 0 and 30 specifying the number of bits used for color attributes. Lower values produce better compression, but will lose precision. A value of 0 does not set quantization.
 * @param {Number} [options.dracoOptions.quantizeSkin=12] A value between 0 and 30 specifying the number of bits used for skinning attributes (joint indices and joint weights). Lower values produce better compression, but will lose precision. A value of 0 does not set quantization.
 * @param {Boolean} [options.dracoOptions.unifiedQuantization=false] Quantize positions, defined by the unified bounding box of all primitives. If not set, quantization is applied separately.
 * @returns {Object} The glTF asset with compressed meshes.
 *
 * @private
 */
function decompressDracoMeshes(gltf, options) {

    ForEach.mesh(gltf, function(mesh) {
        ForEach.meshPrimitive(mesh, function(primitive) {
            // Only support triangles now.
            if (defined(primitive.mode) && primitive.mode !== 4) {
                // Skipping primitive. Unsupported primitive mode.
                return;
            }

            if (defined(primitive.extensions) &&
                defined(primitive.extensions.KHR_draco_mesh_compression)) {
                console.log('Decompress Draco primitive buferView:' + primitive.extensions.KHR_draco_mesh_compression.bufferView);

                var dracoExtension = primitive.extensions.KHR_draco_mesh_compression;
                var bufferViewId = dracoExtension.bufferView;
                var bufferView = gltf.bufferViews[bufferViewId];
                var buffer = gltf.buffers[bufferView.buffer];
                var sourceBufferData = buffer.extras._pipeline.source;
                var source = new Uint8Array(sourceBufferData.buffer);
                var compressedData = source.slice(bufferView.byteOffset, bufferView.byteOffset + bufferView.byteLength);

                var dracoBuffer = new decoderModule.DecoderBuffer();
                dracoBuffer.Init(compressedData, buffer.byteLength);

                var decoder = new decoderModule.Decoder();

                /*
                * Determine what type is this file: mesh or point cloud.
                */
                var geometryType = decoder.GetEncodedGeometryType(dracoBuffer);
                if (geometryType == decoderModule.TRIANGULAR_MESH) {
                    console.log('Loaded a mesh.');
                } else if (geometryType == decoderModule.POINT_CLOUD) {
                    console.log('Loaded a point cloud.');
                }

                decmopressDracoMesh(gltf, primitive, decoderModule, decoder, geometryType, dracoBuffer, dracoExtension);
                removePrimitiveExtension(primitive, 'KHR_draco_mesh_compression');
                removeExtensionsUsed(gltf, 'KHR_draco_mesh_compression');
            }
        });
    });

    gltf = removeUnusedElements(gltf);
    return gltf;
}

// TODO: Check if this function exits or think about making it public.
function addBufferToGltf(gltf, buffer) {
    var encodedLength = buffer.length;
    var buffer = {
        byteLength : encodedLength,
        extras : {
            _pipeline : {
                source : buffer
            }
        }
    };
    var bufferId = addToArray(gltf.buffers, buffer);
    var bufferView = {
        buffer : bufferId,
        byteOffset : 0,
        byteLength : encodedLength
    };
    var bufferViewId = addToArray(gltf.bufferViews, bufferView);
    return bufferViewId;
}

/**
 * Removes an extension from primitive.extensions if it is present.
 *
 * @param {Object} primitive A javascript object containing a glTF primitive asset.
 * @param {String} extension The extension to remove.
 *
 * @private
 */
function removePrimitiveExtension(primitive, extension) {
    var extensions = primitive.extensions;
    if (defined(extensions)) {
        if (defined(extensions[extension])) {
            delete extensions[extension];

            // Check if extensions is empty.
            if (Object.keys(extensions).length === 0) {
                delete primitive.extensions;
            }
        }
    }
}

function getIndicesBuffer(gltf, accessor, decoderModule, decoder, dracoGeometry, numFaces) {
    // Convert indices
    var numIndices = numFaces * 3;
    var indices;
    if (accessor.componentType === 5120) {
        indices = new Int8Array(numIndices);
    } else if (accessor.componentType === 5121) {
        indices = new Uint8Array(numIndices);
    } else if (accessor.componentType === 5122) {
        indices = new Int16Array(numIndices);
    } else if (accessor.componentType === 5123) {
        indices = new Uint16Array(numIndices);
    } else {
        indices = new Uint32Array(numIndices);
    }
    var ia = new decoderModule.DracoInt32Array();
    for (var i = 0; i < numFaces; ++i) {
        decoder.GetFaceFromMesh(dracoGeometry, i, ia);
        var index = i * 3;
        indices[index] = ia.GetValue(0);
        indices[index + 1] = ia.GetValue(1);
        indices[index + 2] = ia.GetValue(2);

        //console.log('index:' + index + ' ' + indices[index] + ', ' + indices[index + 1] + ', ' + indices[index + 2]);
    }

    decoderModule.destroy(ia);

    var indicesUint8Data = new Buffer.from(indices.buffer);
    return indicesUint8Data;
}

function getAttributeBuffer(gltf, decoderModule, decoder, dracoGeometry, attribute) {
    console.log('attribute type:' + attribute.attribute_type() + '  data_type:' + attribute.data_type());

    var numComponents = attribute.num_components();
    //var attributeData = new dracoDecoder.DracoFloat32Array();
    var numPoints = dracoGeometry.num_points();
    var numValues = numPoints * numComponents;

    console.log('numPoints:' + numPoints + '  numComponents:' + numComponents + '  numValues:' + numValues);

    var attributeData;
    var attributeArray;
    if (attribute.data_type() === 1) {
        attributeData = new decoderModule.DracoInt8Array();
        var gotData = decoder.GetAttributeInt8ForAllPoints(dracoGeometry, attribute, attributeData);
        console.log('decoder.GetAttributeInt8ForAllPoints() :' + gotData + '  size():' + attributeData.size());
        attributeArray = new Int8Array(attributeData.size());
    } else if (attribute.data_type() === 2) {
        attributeData = new decoderModule.DracoUInt8Array();
        var gotData = decoder.GetAttributeUInt8ForAllPoints(dracoGeometry, attribute, attributeData);
        console.log('decoder.GetAttributeUInt8ForAllPoints() :' + gotData + '  size():' + attributeData.size());
        attributeArray = new Uint8Array(attributeData.size());
    } else if (attribute.data_type() === 3) {
        attributeData = new decoderModule.DracoInt16Array();
        var gotData = decoder.GetAttributeInt16ForAllPoints(dracoGeometry, attribute, attributeData);
        console.log('decoder.GetAttributeInt16ForAllPoints() :' + gotData + '  size():' + attributeData.size());
        attributeArray = new Int16Array(attributeData.size());
    } else if (attribute.data_type() === 4) {
        attributeData = new decoderModule.DracoUInt16Array();
        var gotData = decoder.GetAttributeUInt16ForAllPoints(dracoGeometry, attribute, attributeData);
        console.log('decoder.GetAttributeUInt16ForAllPoints() :' + gotData + '  size():' + attributeData.size());
        attributeArray = new Uint16Array(attributeData.size());
    } else if (attribute.data_type() === 6) {
        attributeData = new decoderModule.DracoUInt32Array();
        var gotData = decoder.GetAttributeUInt32ForAllPoints(dracoGeometry, attribute, attributeData);
        console.log('decoder.GetAttributeUInt32ForAllPoints() :' + gotData + '  size():' + attributeData.size());
        attributeArray = new Uint32Array(attributeData.size());
    } else if (attribute.data_type() === 5) {
        // TODO: Check about data_type. Box.gltf indices look to use shorts to store the indices,
        // but the code below will use ints, which is twice the size of the original Box.gltf.
        // Need to add support to draco encoder and decoder for other types.
        attributeData = new decoderModule.DracoInt32Array();
        var gotData = decoder.GetAttributeInt32ForAllPoints(dracoGeometry, attribute, attributeData);
        console.log('decoder.GetAttributeInt32ForAllPoints() :' + gotData + '  size():' + attributeData.size());
        attributeArray = new Uint32Array(attributeData.size());
    } else {
        attributeData = new decoderModule.DracoFloat32Array();
        var gotData = decoder.GetAttributeFloatForAllPoints(dracoGeometry, attribute, attributeData);
        console.log('decoder.GetAttributeFloatForAllPoints() :' + gotData + '  size():' + attributeData.size());
        attributeArray = new Float32Array(attributeData.size());
    }

    for (var i = 0; i < numValues; i++) {
        attributeArray[i] = attributeData.GetValue(i);
        //console.log('[' + i + ']:' + attributeData.GetValue(i));
    }

    decoderModule.destroy(attributeData);
    var attributeBuffer = new Buffer.from(attributeArray.buffer);
    return attributeBuffer;
}

function decmopressDracoMesh(gltf, primitive, decoderModule, decoder, geometryType, dracoBuffer, dracoExtension) {
    var dracoGeometry;
    var decodingStatus;
    //const start_time = performance.now();
    if (geometryType === decoderModule.TRIANGULAR_MESH) {
        dracoGeometry = new decoderModule.Mesh();
        decodingStatus = decoder.DecodeBufferToMesh(dracoBuffer, dracoGeometry);
    } else {
        dracoGeometry = new decoderModule.PointCloud();
        decodingStatus =
            decoder.DecodeBufferToPointCloud(dracoBuffer, dracoGeometry);
    }
    if (!decodingStatus.ok() || dracoGeometry.ptr == 0) {
        var errorMsg = 'THREE.DRACOLoader: Decoding failed: ';
        errorMsg += decodingStatus.error_msg();
        console.error(errorMsg);
        decoderModule.destroy(decoder);
        decoderModule.destroy(dracoGeometry);
        throw new Error(errorMsg);
    }

    //var decode_end = performance.now();
    decoderModule.destroy(dracoBuffer);
    /*
     * Example on how to retrieve mesh and attributes.
     */
    var numFaces;
    if (geometryType == decoderModule.TRIANGULAR_MESH) {
        numFaces = dracoGeometry.num_faces();
        console.log('Number of faces loaded: ' + numFaces.toString());
    } else {
        numFaces = 0;
    }

    var numPoints = dracoGeometry.num_points();
    var numAttributes = dracoGeometry.num_attributes();
    console.log('Number of points loaded: ' + numPoints.toString());
    console.log('Number of attributes loaded: ' + numAttributes.toString());

    // Verify if there is position attribute.
    var posAttId = decoder.GetAttributeId(dracoGeometry,
                                          decoderModule.POSITION);
    if (posAttId == -1) {
        var errorMsg = 'THREE.DRACOLoader: No position attribute found.';
        console.error(errorMsg);
        decoderModule.destroy(decoder);
        decoderModule.destroy(dracoGeometry);
        throw new Error(errorMsg);
    }

    var indicesId = primitive.indices;
    var indicesAccessor = gltf.accessors[indicesId];
    var indicesBuffer = getIndicesBuffer(gltf, indicesAccessor, decoderModule, decoder, dracoGeometry, numFaces);
    var bufferViewId = addBufferToGltf(gltf, indicesBuffer);

    // Add decompressed indices data to indices accessor.
    var indicesAccessorId = primitive.indices;
    var indicesAccessor = gltf.accessors[indicesAccessorId];
    indicesAccessor.bufferView = bufferViewId;
    indicesAccessor.byteOffset = 0;

    var attributes = dracoExtension.attributes;

    // TOOD: Change this to a ForEach.
    for (var semantic in attributes) {
        if (attributes.hasOwnProperty(semantic)) {
            console.log('semantic:' + semantic + '  attributes[semantic]:' + attributes[semantic]);

            var attribute = decoder.GetAttributeByUniqueId(dracoGeometry, attributes[semantic]);
            var attributeBuffer = getAttributeBuffer(gltf, decoderModule, decoder, dracoGeometry, attribute);
            var bufferViewId = addBufferToGltf(gltf, attributeBuffer);
            var gltfAttributeId = primitive.attributes[semantic];
            var attributeAccessor = gltf.accessors[gltfAttributeId];

            console.log('attr[' + gltfAttributeId + '] componentType:' + attributeAccessor.componentType + ' count:' + attributeAccessor.count + ' type:' + attributeAccessor.type);

            attributeAccessor.count = numPoints;
            attributeAccessor.bufferView = bufferViewId;
            attributeAccessor.byteOffset = 0;
        }
    }
}

